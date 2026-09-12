import json
from fastapi import FastAPI
from fastapi.testclient import TestClient
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import deployment


def client(role='admin'):
    app=FastAPI();app.include_router(deployment.router,prefix='/api/v1')
    app.dependency_overrides[get_current_user]=lambda:WebUser(id=1,username='fixture',role=role)
    return TestClient(app)


def payload():
    return {'schema_version':1,'observed_at':'2026-09-10T12:00:00Z','components':[{'id':'api','name':'Hummingbot API','image_id':'sha256:'+'a'*64,'source_manifest':'b'*64,'commit':'c'*40,'started_at':'2026-09-10T11:00:00Z','private_path':'DO_NOT_RETURN'}], 'release':{'root_commit':'d'*40,'condor_commit':'e'*40,'api_commit':'f'*40,'deployed_at':'2026-09-10T11:00:00Z'},'pending':[{'component':'execution-main','reason':'Telemetry update awaits an approved owner restart.'}]}


def test_absent_and_denied(monkeypatch):
    monkeypatch.delenv('CONDOR_DEPLOYMENT_OBSERVATION_FILE',raising=False)
    assert client().get('/api/v1/deployment').json()['recorded'] is False
    assert client('trader').get('/api/v1/deployment').status_code==403


def test_allowlist_source_and_errors(monkeypatch,tmp_path):
    path=tmp_path/'versions.json';path.write_text(json.dumps(payload()))
    monkeypatch.setenv('CONDOR_DEPLOYMENT_OBSERVATION_FILE',str(path))
    r=client().get('/api/v1/deployment');assert r.status_code==200
    assert r.json()['components'][0]['commit']=='c'*40
    assert 'DO_NOT_RETURN' not in r.text
    assert r.headers['cache-control']=='no-store'
    path.write_text('{invalid DO_NOT_RETURN')
    r=client().get('/api/v1/deployment');assert r.status_code==503;assert 'DO_NOT_RETURN' not in r.text


def test_duplicate_component_future_time_and_symlink_rejected(monkeypatch,tmp_path):
    path=tmp_path/'versions.json';monkeypatch.setenv('CONDOR_DEPLOYMENT_OBSERVATION_FILE',str(path))
    for change in [lambda p:p['components'].append(p['components'][0]),lambda p:p.update(observed_at='2999-01-01T00:00:00Z')]:
        p=payload();change(p);path.write_text(json.dumps(p));assert client().get('/api/v1/deployment').status_code==503
    link=tmp_path/'link';link.symlink_to(path);monkeypatch.setenv('CONDOR_DEPLOYMENT_OBSERVATION_FILE',str(link));assert client().get('/api/v1/deployment').status_code==503


def test_research_health_is_an_explicit_no_parameter_read_contract():
    from condor.research_read import validated_parameters, _valid_shape
    assert validated_parameters('health', []) == {}
    p={'status':'degraded','checked_at':'2026-09-12T12:00:00Z','read_model':{'readable':True,'revision':'r'},'freshness':{'state':'PENDING'},'freshness_basis':'synchronization_receipt','reason':'Pending events'}
    assert _valid_shape('health',p,{})
    p['read_model']['readable']='yes'
    assert not _valid_shape('health',p,{})
