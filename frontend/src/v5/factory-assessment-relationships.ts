import type { AssessmentRow, ProjectionEnvelope, UnavailableRowStub } from './learning-projection';
import { canonicalJson } from './learning-projection-validate';

type Envelope = ProjectionEnvelope<AssessmentRow | UnavailableRowStub>;
type Fact = Pick<AssessmentRow, 'record_id' | 'row_sha256' | 'evaluation_id' | 'verdict' | 'admission'> & {
  group: string | null;
  supersedes: string | null;
};
interface Segment { cursor: string | null; next: string | null; facts: Fact[] }

const MAX_RELATIONSHIP_ROWS = 2_000;
const MAX_RELATIONSHIP_PAGES = 128;

export class AssessmentTraversal {
  private binding: string | null = null;
  private segments: Segment[] = [];

  clear() { this.binding = null; this.segments = []; }

  observe(envelope: Envelope, index: number, cursor: string | null, revision: string | undefined): ReadonlyMap<string, string> | null {
    const total = envelope.coverage.total_items;
    if (!revision || envelope.status === 'UNAVAILABLE' || !envelope.scope || !envelope.snapshot_id || total === null
      || total > MAX_RELATIONSHIP_ROWS || index >= MAX_RELATIONSHIP_PAGES || envelope.coverage.omitted_items !== 0
      || envelope.coverage.unresolved_membership_items !== 0) {
      this.clear();
      return null;
    }
    const binding = JSON.stringify([envelope.scope.scope_sha256, envelope.projection_revision, envelope.snapshot_id, envelope.verified_at_ms, revision, total]);
    if (this.binding !== binding) { this.clear(); this.binding = binding; }
    if (index > this.segments.length || cursor !== (index === 0 ? null : this.segments[index - 1]?.next)
      || (cursor !== null && this.segments.slice(0, index).some(segment => segment.cursor === cursor))) {
      this.clear();
      return null;
    }
    const facts: Fact[] = [];
    for (const row of envelope.items) {
      if (row.row_status === 'UNAVAILABLE' || row.idea_revision_id !== revision || (row.supersedes && row.supersedes.resolution !== 'RESOLVED')
        || (row.admission === 'ADMITTED_COMPARISON' && (!row.comparison || row.run_ref.resolution !== 'RESOLVED' || row.issues.some(issue => issue.code === 'OMITTED_CONTENT')))) {
        this.clear();
        return null;
      }
      facts.push({
        record_id: row.record_id, row_sha256: row.row_sha256, evaluation_id: row.evaluation_id, admission: row.admission, verdict: row.verdict,
        group: row.comparison ? canonicalJson([row.comparison.comparison_group, row.comparison.conditions]) : null,
        supersedes: row.supersedes?.record_id ?? null,
      });
    }
    const next = envelope.page.next_cursor;
    if (next !== null && (next === cursor || this.segments.slice(0, index).some(segment => segment.cursor === next))) {
      this.clear();
      return null;
    }
    const previous = this.segments[index];
    if (!previous || previous.cursor !== cursor || previous.next !== next || previous.facts.length !== facts.length
      || facts.some((fact, offset) => previous.facts[offset]?.row_sha256 !== fact.row_sha256)) {
      this.segments = [...this.segments.slice(0, index), { cursor, next, facts }];
    }
    const accumulated = this.segments.flatMap(segment => segment.facts);
    const byId = new Map(accumulated.map(fact => [fact.record_id, fact]));
    if (accumulated.length > total || accumulated.length !== byId.size) { this.clear(); return null; }
    if (this.segments.at(-1)?.next !== null || accumulated.length !== total) return null;

    const retired = new Set<string>();
    for (const fact of accumulated) {
      if (!fact.supersedes) continue;
      if (byId.get(fact.supersedes)?.evaluation_id !== fact.evaluation_id || retired.has(fact.supersedes)) return null;
      const seen = new Set([fact.record_id]);
      let current: string | null = fact.supersedes;
      while (current !== null) {
        if (seen.has(current) || !byId.has(current)) return null;
        seen.add(current);
        const target = byId.get(current);
        if (!target || target.evaluation_id !== fact.evaluation_id) return null;
        current = target.supersedes;
      }
      retired.add(fact.supersedes);
    }
    const groups = new Map<string, Fact[]>();
    const evaluations = new Map<string, Fact[]>();
    for (const fact of accumulated) {
      if (retired.has(fact.record_id)) continue;
      evaluations.set(fact.evaluation_id, [...(evaluations.get(fact.evaluation_id) ?? []), fact]);
      if (fact.group && fact.admission === 'ADMITTED_COMPARISON') groups.set(fact.group, [...(groups.get(fact.group) ?? []), fact]);
    }
    const labels = new Map([...retired].map(recordId => [recordId, 'Superseded by an explicit owner link']));
    for (const active of evaluations.values()) {
      if (active.length <= 1) continue;
      if (active.some(fact => fact.admission !== 'RECORDED_ONLY')) return null;
      for (const fact of active) labels.set(fact.record_id, 'Recorded evaluation identity collision');
    }
    for (const group of groups.values()) {
      const verdicts = new Set(group.map(fact => fact.verdict));
      const conflict = verdicts.has('SUPPORTED') && verdicts.has('CONTRADICTED');
      for (const fact of group) labels.set(fact.record_id, conflict ? 'Conflicting recorded assessments' : 'Current in this recorded comparison group');
    }
    return labels;
  }
}
