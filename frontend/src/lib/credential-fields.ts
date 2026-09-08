export interface CredentialField {
  key: string;
  label: string;
  required: boolean;
  description: string;
  isSecret: boolean;
  defaultValue: string;
  options: { value: string; label: string }[];
}

export function credentialFields(schema: Record<string, unknown> | undefined): CredentialField[] {
  return Object.entries(schema ?? {}).flatMap(([key, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const value = raw as Record<string, unknown>;
    const isSecret = /secret|password|passphrase|key|token|private|mnemonic|seed/i.test(`${key} ${value.type ?? ''}`);
    const declared = value.options ?? value.enum ?? value.allowed_values;
    const options = Array.isArray(declared) ? declared.flatMap(option => {
      if (typeof option === 'string') return [{ value: option, label: option }];
      if (option && typeof option === 'object' && typeof option.value === 'string') {
        return [{ value: option.value, label: typeof option.label === 'string' ? option.label : option.value }];
      }
      return [];
    }) : [];
    return [{
      key,
      label: typeof value.label === 'string' ? value.label : key,
      required: value.required !== false,
      description: typeof value.description === 'string' ? value.description : '',
      isSecret,
      defaultValue: !isSecret && typeof value.default === 'string' ? value.default : '',
      options,
    }];
  });
}

export function credentialPayload(fields: CredentialField[], values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(fields.map(field => [field.key, values[field.key] ?? field.defaultValue]));
}

export function missingCredentialFields(fields: CredentialField[], values: Record<string, string>): string[] {
  const payload = credentialPayload(fields, values);
  return fields.filter(field => (field.required && !payload[field.key].trim())
    || (payload[field.key] !== '' && field.options.length > 0 && !field.options.some(option => option.value === payload[field.key])))
    .map(field => field.key);
}
