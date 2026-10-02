export function connectionPage(nonce: string, session: string) {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect a computer · Labora</title>
<style nonce="${nonce}">
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#141414;color:#eee;font-size:16px}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:28px}main{width:min(100%,480px)}h1{font-size:28px;letter-spacing:-.6px;font-weight:600;margin:0 0 14px}p{color:#aaa;line-height:1.55;margin:0 0 24px}button,a.button{font:inherit;cursor:pointer;border:1px solid #404040;border-radius:10px;min-height:44px;padding:11px 16px;color:#eee;background:#252525;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}button:disabled{opacity:.5;cursor:default}button.primary,a.primary{background:#eee;color:#111;border-color:#eee}button:hover:not(:disabled),a.button:hover{filter:brightness(1.12)}button:focus-visible,a:focus-visible{outline:2px solid #fff;outline-offset:4px}.actions{display:flex;gap:10px;flex-wrap:wrap}.computer{display:flex;width:100%;text-align:left;align-items:center;justify-content:space-between;gap:20px;border:0;border-bottom:1px solid #333;background:transparent;border-radius:0;padding:18px 0}.computer strong{display:block;font-weight:500}.computer small{display:block;color:#aaa;font-size:13px;margin-top:5px}.computer span:last-child{font-size:14px;color:#aaa}.computers{margin:8px 0 24px}.error{color:#ffb7b7;margin:18px 0}.hidden{display:none!important}a{color:inherit}.quiet{margin-top:24px;font-size:14px}#status{min-height:24px;margin-top:18px;font-size:14px}svg{width:40px;height:40px;stroke:#ddd;fill:none;stroke-width:1.4;margin-bottom:24px}#done svg{stroke:#ddd}@media(max-width:520px){body{padding:24px}h1{font-size:25px}.actions>*{flex:1}}@media(prefers-reduced-motion:no-preference){button,a.button{transition:background-color 140ms ease,color 140ms ease}}
</style>
<main>
<section id="start"><svg viewBox="0 0 40 40" aria-hidden="true"><rect x="4" y="5" width="32" height="23" rx="3"/><path d="M14 35h12M20 28v7"/></svg><h1>Connect a computer</h1>
<p id="intro">Checking Tailscale on this device…</p>
<div id="install" class="actions hidden"><a class="button primary" href="https://tailscale.com/download" target="_blank" rel="noreferrer">Install Tailscale</a><button data-action="refresh">Check again</button></div>
<div id="unavailable" class="actions hidden"><button data-action="refresh">Check again</button></div>
<div id="signin" class="actions hidden"><button class="primary" id="login">Sign in to Tailscale</button><a id="auth-link" class="button hidden" target="_blank" rel="noreferrer">Continue sign-in</a></div>
<div id="choose" class="hidden"><div id="computers" class="computers"></div><div class="actions"><button data-action="refresh">Refresh computers</button></div><p class="quiet">Missing a computer? Open Labora Computer on that PC and enable access in its setup page.</p></div>
<div id="approving" class="hidden"><p id="approval-message"></p><div class="actions"><a id="approval-link" class="button primary" target="_blank" rel="noreferrer">Review connection</a><button id="cancel">Cancel</button></div></div>
</section>
<section id="done" class="hidden"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16"/><path d="m12 20 6 6 11-12"/></svg><h1 id="connected-name">Computer connected</h1><p>You can return to Labora. This tab can be closed.</p></section>
<p id="error" class="error hidden" role="alert"></p><button id="retry" class="hidden" data-action="refresh">Try again</button><button id="cleanup" class="hidden">Retry cancellation</button><p id="status" role="status" aria-live="polite"></p>
</main>
<script nonce="${nonce}">
const session=${JSON.stringify(session)};
const base=location.pathname;
const el=id=>document.getElementById(id);
let current, popup, refreshing=false, stopped=false, actionPending=false;
function show(id,yes){el(id).classList.toggle('hidden',!yes)}
async function api(path,body){const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Labora-Session':session},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not complete the request.');return data;}
function failure(error){el('error').textContent=error.message;show('error',true);show('retry',true)}
function render(state){current=state;show('error',!!state.error);show('retry',!!state.error&&!state.cleanupPending);show('cleanup',!!state.cleanupPending);el('error').textContent=state.error||'';const connected=state.stage==='connected';show('done',connected);show('start',!connected);el('connected-name').textContent=state.connectedName?state.connectedName+' connected':'Computer connected';show('install',state.stage==='install');show('unavailable',state.stage==='unavailable');show('signin',state.stage==='signin');show('choose',state.stage==='choose');show('approving',state.stage==='approving'&&!state.cleanupPending);el('status').textContent=state.busy?'Looking for computers…':'';
el('intro').textContent=state.stage==='install'?'Install Tailscale on this device, then come back here.':state.stage==='unavailable'?state.unavailableReason||'Open Tailscale to start its background service.':state.stage==='signin'?'Sign in with the Tailscale account you use on your PCs.':state.stage==='choose'?'Choose the computer you want Labora to use.':state.stage==='approving'?'Approve the connection in the browser tab that just opened.':'Checking Tailscale on this device…';
show('auth-link',!!state.authUrl);if(state.authUrl){el('auth-link').href=state.authUrl;if(popup&&!popup.closed){popup.location.replace(state.authUrl);popup=null;}}
el('login').disabled=state.loginPending||actionPending;
if(state.approvalUrl){el('approval-link').href=state.approvalUrl;el('approval-message').textContent='Waiting for your approval for '+state.selectedName+'.';}
if(state.stage==='choose'){const list=el('computers');list.replaceChildren();for(const computer of state.computers){const button=document.createElement('button');button.className='computer';button.disabled=actionPending||!computer.ready;const text=document.createElement('span');const name=document.createElement('strong');name.textContent=computer.name;const detail=document.createElement('small');detail.textContent=computer.ready?computer.platform:computer.online?'Labora Computer is not ready':'Offline';text.append(name,detail);const action=document.createElement('span');action.textContent=computer.ready?'Connect':'';button.append(text,action);button.onclick=()=>connect(computer.id);list.append(button);}if(!state.computers.length){const message=document.createElement('p');message.textContent='No computers are available yet.';list.append(message);}}
if(connected)stopped=true;}
async function refresh(){if(refreshing||stopped)return;refreshing=true;try{render(await api('status'))}catch(error){failure(error)}finally{refreshing=false}}
async function act(path,body={}){if(actionPending)return;actionPending=true;try{render(await api(path,body));}catch(error){if(popup&&!popup.closed)popup.close();popup=null;failure(error)}finally{actionPending=false;el('login').disabled=!!current?.loginPending;}}
async function connect(id){if(actionPending)return;const approval=window.open('about:blank','_blank');if(approval)approval.opener=null;actionPending=true;try{const state=await api('connect',{id});render(state);if(approval&&state.approvalUrl)approval.location.replace(state.approvalUrl);else if(approval)approval.close();}catch(error){if(approval)approval.close();failure(error)}finally{actionPending=false}}
el('login').onclick=()=>{popup=window.open('about:blank','_blank');if(popup)popup.opener=null;void act('login')};
el('cancel').onclick=()=>act('cancel');
el('cleanup').onclick=()=>act('cleanup');
document.querySelectorAll('[data-action="refresh"]').forEach(button=>button.onclick=()=>act('refresh'));
void refresh();setInterval(refresh,1200);
</script></html>`;
}
