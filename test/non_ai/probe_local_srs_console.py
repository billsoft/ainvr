"""AINVR bounded console/SRS API probe; temporary session revoked on exit."""
import getpass,json,urllib.request
base='http://127.0.0.1:3001/api'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def request(path,method='GET',body=None,token=None):
    headers={'Content-Type':'application/json'} if body else {}
    if token:headers['x-console-token']=token
    req=urllib.request.Request(base+path,headers=headers,method=method,
        data=json.dumps(body).encode() if body else None)
    with opener.open(req,timeout=10) as r:return json.load(r)
login=request('/auth/login','POST',{'password':getpass.getpass('Console password: ')})
token=login['data']['token']
try:
    for path in ['/ai/streams','/settings']:
        result=request(path,token=token)
        if path=='/settings':
            print('srsApiHost',result.get('data',result).get('srsApiHost'))
        else:print(json.dumps({'endpoint':path,'result':result}))
finally:request('/auth/logout','POST',token=token)
