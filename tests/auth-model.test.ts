import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { Auth, validateCallback } from '../src/auth.js';
import { Model, readSSE } from '../src/model.js';

test('OAuth callback rejects wrong state, expired attempt and client substitution',()=>{
  const a={state:'expected',nonce:'n',verifier:'v',redirect:'http://127.0.0.1/auth/callback',expires:Date.now()+1000};
  assert.throws(()=>validateCallback(a,new URLSearchParams({state:'wrong',code:'x',client_id:'oaiapp_test'})),/oauth_invalid_state/);
  assert.throws(()=>validateCallback({...a,expires:0},new URLSearchParams({state:'expected',code:'x',client_id:'oaiapp_test'})),/oauth_invalid_state/);
  assert.throws(()=>validateCallback(a,new URLSearchParams({state:'expected',code:'x',client_id:'dynamic_agent_client'})),/oauth_client_mismatch/);
  assert.throws(()=>validateCallback({...a,clientId:'saved'},new URLSearchParams({state:'expected',code:'x',client_id:'different'})),/oauth_client_mismatch/);
  assert.throws(()=>validateCallback(a,new URLSearchParams({state:'expected',error:'access_denied'})),/oauth_access_denied/);
});

test('registered identity, permission, persistent host ID and serialized rotating refresh',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ssal-auth-test-'));const original=globalThis.fetch;
  const keys=await generateKeyPair('RS256');const jwk=await exportJWK(keys.publicKey);jwk.kid='test-key';jwk.alg='RS256';
  let nonce='';let refreshes=0;
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.includes('jwks'))return Response.json({keys:[jwk]});
    const body=new URLSearchParams(String(init?.body));
    assert.equal(body.get('client_id'),'oaiapp_test');
    if(body.get('grant_type')==='refresh_token'){
      refreshes++;assert.equal(body.get('scope'),null);assert.equal(body.get('refresh_token'),'refresh-one');
      await new Promise(r=>setTimeout(r,10));
      return Response.json({access_token:'access-two',refresh_token:'refresh-two',expires_in:3600,scope:'chatgpt.tokens.use.direct'});
    }
    assert.equal(body.get('redirect_uri'),'http://127.0.0.1:4317/auth/callback');assert.ok(body.get('code_verifier'));
    const id=await new SignJWT({nonce,email:'synthetic@example.invalid'}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://auth.openai.com').setSubject('synthetic-sub').setAudience('oaiapp_test').setExpirationTime('5m').sign(keys.privateKey);
    return Response.json({access_token:'access-one',refresh_token:'refresh-one',id_token:id,expires_in:1,scope:'openid chatgpt.tokens.use.direct'});
  };
  try{
    const auth=new Auth(dir);const url=new URL(auth.begin('http://127.0.0.1:4317/auth/callback'));nonce=url.searchParams.get('nonce')!;
    assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    await auth.callback(new URLSearchParams({state:url.searchParams.get('state')!,code:'synthetic',client_id:'oaiapp_test'}));
    assert.equal(auth.publicInfo().accounts[0]?.planEnabled,true);
    assert.ok(!JSON.stringify(auth.publicInfo()).includes('access-one'));
    const choice={kind:'chatgpt' as const,accountId:'oaiapp_test',model:'test'};
    assert.deepEqual(await Promise.all([auth.bearer(choice),auth.bearer(choice)]),['access-two','access-two']);assert.equal(refreshes,1);
    const saved=JSON.parse(readFileSync(join(dir,'credentials.json'),'utf8'));assert.equal(saved.accounts[0].refreshToken,'refresh-two');
    assert.equal(statSync(join(dir,'credentials.json')).mode&0o777,0o600);
    const restored=new Auth(dir);const next=new URL(restored.begin('http://127.0.0.1:9999/auth/callback','oaiapp_test'));
    assert.equal(next.searchParams.get('ext_agent_host_id'),url.searchParams.get('ext_agent_host_id'));assert.equal(next.searchParams.get('client_id'),'oaiapp_test');assert.equal(next.searchParams.get('agent_name_hint'),null);
  }finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});

function stream(events:unknown[],chunkSize=7){const text=events.map(e=>`data: ${JSON.stringify(e)}\r\n\r\n`).join('');return new Response(new ReadableStream({start(c){for(let i=0;i<text.length;i+=chunkSize)c.enqueue(new TextEncoder().encode(text.slice(i,i+chunkSize)));c.close();}}));}
test('SSE requires terminal completion and handles fragmented events and late errors',async()=>{
  const result=await readSSE(stream([{type:'response.output_text.delta',delta:'hello'},{type:'response.completed',response:{status:'completed',output:[]}}]));assert.equal(result.status,'completed');
  await assert.rejects(()=>readSSE(stream([{type:'response.output_text.delta',delta:'not final'}])),/inference_stream_interrupted/);
  await assert.rejects(()=>readSSE(stream([{type:'response.output_text.delta',delta:'partial'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])),/subscription_sharing_usage_limit_exceeded/);
});

test('inference sends actual image plus namespaced tools and never falls back to API billing',async()=>{
  const original=globalThis.fetch;let calls=0;let requests=0;
  const auth={bearer:async(choice:any)=>{calls++;assert.equal(choice.kind,'chatgpt');return 'synthetic-access';}} as Auth;
  const model=new Model(auth);
  globalThis.fetch=async(_input,init)=>{
    requests++;const body=JSON.parse(String(init?.body));assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.tools[0].type,'namespace');assert.equal(body.tools[0].tools[0].name,'step');assert.ok(body.input[0].content[1].image_url.startsWith('data:image/png;base64,'));assert.equal(body.max_output_tokens,undefined);
    return stream([{type:'response.failed',response:{error:{code:'subscription_sharing_user_not_eligible'}}}]);
  };
  try{await assert.rejects(()=>model.decide({kind:'chatgpt',accountId:'synthetic',model:'synthetic'},'test',{},Buffer.from('synthetic screenshot'),new AbortController().signal),/subscription_sharing_user_not_eligible/);assert.equal(calls,1);assert.equal(requests,1);}
  finally{globalThis.fetch=original;}
});
