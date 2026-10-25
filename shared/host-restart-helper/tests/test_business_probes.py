import json
import pytest
import observability as ob

def bootstrap(tmp_path):
    p=tmp_path/'bootstrap.json';p.write_text(json.dumps({'listen':'127.0.0.1:8096','token':'test-only-secret'}));return p

@pytest.mark.parametrize('response,healthy,text',[
    ({'configured':False,'state':'waiting_configuration'},True,'等待配置'),
    ({'configured':True,'enabled':False,'ready':False},True,'已停用'),
    ({'configured':True,'enabled':True,'ready':True},True,'已就绪'),
    ({'configured':True,'enabled':True,'ready':False},False,'尚未就绪'),
    ({'configured':True,'enabled':False,'error':'private error'},False,'应用失败'),
    ({},False,'响应无效'),
])
def test_gateway_business_states(tmp_path,monkeypatch,response,healthy,text):
    monkeypatch.setattr(ob,'private_probe',lambda *a,**k:response)
    ok,detail=ob.gateway_health(bootstrap(tmp_path));assert ok is healthy;assert text in detail;assert 'private error' not in detail

def test_gateway_never_sends_credentials_to_non_loopback(tmp_path,monkeypatch):
    p=bootstrap(tmp_path);p.write_text(json.dumps({'listen':'192.0.2.1:8096','token':'test-only-secret'}))
    monkeypatch.setattr(ob,'private_probe',lambda *a,**k:pytest.fail('must not connect'))
    with pytest.raises(ValueError):ob.gateway_health(p)

@pytest.mark.parametrize('response,healthy',[({'code':0,'data':[{'delay':0}]},True),({'code':-100,'msg':'secret error'},False),({'code':0,'data':[]},False)])
def test_media_checks_api_result(tmp_path,monkeypatch,response,healthy):
    p=tmp_path/'media.ini';p.write_text('[http]\nport=8097\n[api]\nsecret=test-only-secret\n')
    monkeypatch.setattr(ob,'private_probe',lambda *a,**k:response)
    assert ob.gb_media_health(p)[0] is healthy

def test_srs_api_error_is_not_healthy(monkeypatch):
    monkeypatch.setattr(ob,'http_json',lambda url:{'code':1})
    assert not ob.srs_health()
    monkeypatch.setattr(ob,'http_json',lambda url:{'code':0,'data':{'version':'7.0'}})
    assert ob.srs_health()

def test_redirect_cannot_forward_probe_credentials():
    with pytest.raises(ValueError):ob.NoProbeRedirect().redirect_request(None,None,302,'',{},'http://other')
