import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const current = resolve(process.argv[2] ?? 'src/MshTV.Server/bin/Release/net10.0/MshTV.Server.dll');
const legacy = resolve(process.argv[3] ?? '.data/workspace-legacy-v10/MshTV.Server.dll');
assert.ok(existsSync(current) && existsSync(legacy), 'Provide the new and pre-workspace server DLLs as arguments');
mkdirSync(join(root, '.data'), { recursive: true });
const fixture = mkdtempSync(join(root, '.data', 'workspace-smoke-'));
const data = join(fixture, 'data'), source = join(fixture, 'source'), destination = join(fixture, 'export');
mkdirSync(source); mkdirSync(destination);
const origin = 'http://127.0.0.1:5276';
const { chromium } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');
let processHandle, exit, headers, browser;

function image(name, color) {
  const result = spawnSync('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','color=c='+color+':s=320x180',
    '-frames:v','1','-threads','1',join(source,name)], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function until(check, limit = 25) {
  const deadline=Date.now()+limit*1000;
  while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(100);}
  throw Error('Workspace smoke timed out');
}
async function launch(binary, databaseDirectory, stderr = null) {
  assert.equal(await fetch(origin+'/api/v1/health').then(()=>true).catch(()=>false),false,'Test port already occupied');
  processHandle=spawn(join(root,'.tools','dotnet','dotnet.exe'),[binary,'--webroot',join(root,'apps','web','dist')],{
    cwd:dirname(binary),env:{...process.env,MSHTV_PORT:'5276',MSHTV_DATA_DIR:databaseDirectory},
    windowsHide:true,stdio:['ignore','ignore',stderr ? 'pipe' : 'inherit'],
  });
  if(stderr)processHandle.stderr.on('data', stderr);
  exit=once(processHandle,'exit');
}
async function start(binary, databaseDirectory = data) {
  await launch(binary,databaseDirectory);
  await until(()=>{assert.equal(processHandle.exitCode,null);return fetch(origin+'/api/v1/health').then(r=>r.ok).catch(()=>false);});
  const session=await fetch(origin+'/api/v1/session',{method:'POST',headers:{Origin:origin,'X-MshTV-Bootstrap':'1'}});
  assert.equal(session.status,200);
  headers={Origin:origin,Cookie:session.headers.getSetCookie()[0].split(';')[0],'X-CSRF-Token':(await session.json()).csrf,'Content-Type':'application/json'};
}
function send(path,{board,body,method=body?'POST':'GET'}={}) {
  const url=new URL(origin+'/api/v1'+path);
  if(board)url.searchParams.set('boardId',board);
  return fetch(url,{headers,method,body:body?JSON.stringify(body):undefined});
}
async function api(path, options) {
  const response=await send(path,options);
  if(!response.ok)throw Error(path+' '+response.status+' '+await response.text());
  return response.json();
}
async function stop() {
  if(!processHandle||processHandle.exitCode!==null||processHandle.signalCode)return;
  try{await api('/system/shutdown',{body:{}});}catch{}
  if(!await Promise.race([exit.then(()=>true),sleep(2500).then(()=>false)])){processHandle.kill();await exit;}
}
const snapshot=id=>api('/boards/'+id);
const list=()=>api('/workspace');
const entries=async board=>(await api('/assets',{board})).items;
const roots=(board)=>api('/library/roots',{board});
const make=(kind,name,groupId)=>api('/workspace/'+kind,{body:{name,groupId}});
async function alter(kind,id,action,extra={}) {
  const row=(await list())[kind].find(entry=>entry.id===id);
  assert.ok(row);
  return api('/workspace/'+kind+'/'+id,{method:'PATCH',body:{action,revision:row.revision,...extra}});
}
const clientId=crypto.randomUUID();
function mutation(baseRevision,operations){return {baseRevision,clientId,mutationId:crypto.randomUUID(),operations};}
const card=(type,assetId,title,groupId=null)=>({
  id:crypto.randomUUID(),type,assetId,title,text:type==='note'?'<script>旧版备注</script>':'',
  x:24,y:29,width:130,height:100,groupId,
});
const sameContent=(current, original)=>{assert.deepEqual(current.document.items,original.document.items); assert.deepEqual(current.document.groups,original.document.groups);};
try {
  image('legacy.png','green'); image('other.png','blue');
  const original=readFileSync(join(source,'legacy.png'));
  await start(legacy);
  const oldRoot=await api('/library/roots',{body:{path:source,includeSubdirectories:false}});
  const indexed=await until(async()=>{const assets=await entries('main');return assets.length===2&&assets.every(a=>a.status==='ready'&&a.hasThumbnail)&&assets;});
  const originalAsset=indexed.find(a=>a.name==='legacy.png');
  const upload=await fetch(origin+'/api/v1/assets/import?name='+encodeURIComponent('旧版导入.png'),{
    method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:original,
  });
  assert.equal(upload.status,200);
  const importedAsset=await upload.json();
  await until(async()=> (await entries('main')).find(a=>a.id===importedAsset.id&&a.status==='ready'));
  const group={id:crypto.randomUUID(),name:'旧版画布内分组',x:12,y:12,width:230,height:230};
  const oldSnapshot=await snapshot('main');
  const originalCard=card('image',originalAsset.id,'旧版卡片',group.id);
  const note=card('note',null,'旧版备注',group.id);
  note.y=140;
  await api('/boards/main/mutations',{body:mutation(oldSnapshot.revision,[{kind:'putGroup',group},
    ...[originalCard,note].map(item=>({kind:'putItem',item}))])});
  const saved=await snapshot('main');
  await stop();

  await start(current);
  const migrated=await snapshot('main'); sameContent(migrated,saved); assert.equal(migrated.revision,saved.revision);
  assert.deepEqual((await entries('main')).map(x=>x.id).sort(),[...indexed,importedAsset].map(x=>x.id).sort());
  assert.deepEqual(Buffer.from(await (await send('/media/'+importedAsset.id+'/source',{board:'main'})).arrayBuffer()),original);
  assert.deepEqual((await roots('main')).map(x=>[x.id,x.includeSubdirectories]),[[oldRoot.id,false]]);
  const backups=()=>readdirSync(data).filter(x=>x.startsWith('before-workspace-')&&x.endsWith('.db'));
  const backup=backups();
  assert.equal(backup.length,1);
  const originalDb=new DatabaseSync(join(data,backup[0]),{readOnly:true});
  try {
    assert.equal(originalDb.prepare('SELECT Revision FROM Boards WHERE Id=?').get('main').Revision,saved.revision);
    assert.equal(originalDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='LibraryMembers'").get().n,0);
    assert.equal(originalDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally {originalDb.close();}
  console.log('PASS legacy board, root, asset IDs and SQLite backup');

  const g=await make('groups','共同素材'), h=await make('groups','第二画布组');
  const first=await make('boards','第一幕',g.id), peer=await make('boards','第二幕',g.id), outside=await make('boards','第三幕',h.id);
  const independent=await make('boards','独立测试');
  assert.equal((await entries(peer.id)).length,0);
  assert.equal((await send('/media/'+originalAsset.id+'/source',{board:outside.id})).status,404);
  assert.equal((await send('/assets/'+originalAsset.id,{board:independent.id})).status,404);
  assert.deepEqual(await api('/assets/batch?ids='+originalAsset.id,{board:independent.id}),[]);
  const foreign = await send('/boards/'+independent.id+'/mutations',{body:mutation(independent.revision,
    [{kind:'putItem',item:{...originalCard,groupId:null}}])});
  assert.equal(foreign.status,400);
  assert.match((await foreign.json()).title,/素材引用/);
  assert.equal((await send('/library/roots/'+oldRoot.id+'?revision='+oldRoot.revision,{board:independent.id,method:'DELETE'})).status,404);
  const newWatch=await api('/library/roots',{board:independent.id,body:{path:source,newFilesOnly:true,includeSubdirectories:false}});
  await until(async()=> (await roots(independent.id)).some(root=>root.id===newWatch.id&&root.lastScanAt&&!root.baselinePending));
  assert.equal((await entries(independent.id)).length,0);
  image('new.png','red');
  const sharedAsset=await until(async()=>{
    const a=(await entries('main')).find(x=>x.name==='new.png'), b=(await entries(independent.id)).find(x=>x.name==='new.png');
    return a?.status==='ready'&&b?.status==='ready'&&a.id===b.id&&a.version===b.version&&a;
  });
  assert.equal((await entries(independent.id)).length,1);
  console.log('PASS independent monitoring options, scope permissions and shared canonical media');

  await alter('boards','main','move',{groupId:g.id});
  sameContent(await snapshot('main'),saved);
  assert.equal((await roots(peer.id)).length,1);
  assert.equal((await roots(peer.id))[0].includeSubdirectories,false);
  assert.deepEqual((await entries(first.id)).map(x=>x.id),(await entries(peer.id)).map(x=>x.id));
  assert.equal((await entries(peer.id)).length,4);
  for (const sort of ['added','modified']) {
    const args='/assets?sort='+sort;
    const expected=(await api(args,{board:peer.id})).items.map(row=>row.id).reverse();
    const actual=[];
    let cursor=null;
    do {
      const page=await api(args+'&direction=asc&limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{board:first.id});
      for (const item of page.items) actual.push(item.id);
      assert.ok(actual.length<=expected.length);
      cursor=page.nextCursor;
    } while(cursor);
    assert.deepEqual(actual,expected);
  }
  assert.equal((await entries(outside.id)).length,0);
  await alter('boards','main','move',{groupId:h.id});
  sameContent(await snapshot('main'),saved);
  assert.deepEqual((await entries(outside.id)).map(x=>x.id),[originalAsset.id]);
  assert.equal((await roots(outside.id)).length,0);
  assert.equal((await entries(peer.id)).length,4);
  await alter('boards','main','move',{groupId:null});
  sameContent(await snapshot('main'),saved);
  assert.deepEqual((await entries('main')).map(x=>x.id),[originalAsset.id]);
  assert.equal((await roots('main')).length,0);
  const duplicate=await alter('boards','main','copy',{name:'复制画布'});
  sameContent(await snapshot(duplicate.id),saved);
  assert.deepEqual((await entries(duplicate.id)).map(x=>x.id),[originalAsset.id]);
  assert.equal((await send('/media/'+originalAsset.id+'/source',{board:duplicate.id})).status,200);
  assert.equal((await send('/media/'+sharedAsset.id+'/source',{board:duplicate.id})).status,404);
  const cover=await send('/workspace/boards/'+duplicate.id+'/cover');
  assert.ok(cover.headers.get('content-type').startsWith('image/svg+xml'));
  const svg=await cover.text();
  assert.match(svg,/data:image\/webp;base64,/);
  assert.doesNotMatch(svg,/<script>/);
  console.log('PASS merge/move/extract/copy, unchanged layout and generated cover');

  await alter('boards',first.id,'delete');
  await alter('groups',g.id,'delete');
  assert.equal((await send('/boards/'+peer.id)).status,404);
  assert.equal((await send('/assets',{board:peer.id})).status,404);
  assert.equal((await send('/workspace/boards/'+peer.id+'/cover')).status,404);
  assert.equal((await send('/boards/'+outside.id)).status,200);
  await alter('groups',g.id,'restore');
  assert.equal((await send('/boards/'+first.id)).status,404);
  assert.equal((await entries(peer.id)).length,4);
  await alter('boards',first.id,'restore');
  assert.equal((await entries(first.id)).length,4);
  const localAsset = (await entries(peer.id)).find(row=>row.id===sharedAsset.id);
  assert.equal((await send('/assets/'+sharedAsset.id+'?revision='+localAsset.revision,{board:peer.id,method:'DELETE'})).status,200);
  assert.equal((await send('/media/'+sharedAsset.id+'/source',{board:first.id})).status,410);
  assert.equal((await send('/media/'+sharedAsset.id+'/source',{board:independent.id})).status,200);
  assert.equal((await entries(independent.id))[0].id,sharedAsset.id);
  await alter('boards',duplicate.id,'delete');
  assert.equal((await send('/media/'+originalAsset.id+'/source',{board:duplicate.id})).status,404);
  await alter('boards',duplicate.id,'restore');
  sameContent(await snapshot(duplicate.id),saved);

  const exportJob=await api('/exports',{board:duplicate.id,body:{revision:(await snapshot(duplicate.id)).revision,scope:'board',parent:destination,name:'复制画布导出'}});
  const completed=await until(async()=>{const job=await api('/exports/'+exportJob.id,{board:duplicate.id});return job.status==='completed'&&job;});
  assert.equal(completed.succeeded,1);
  assert.equal((await send('/exports/'+exportJob.id,{board:outside.id})).status,404);
  assert.deepEqual(readFileSync(join(completed.path,group.name,'legacy.png')),original);

  browser=await chromium.launch({channel:'msedge'});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading',{name:'工作空间',exact:true}).waitFor();
  const duplicateCover = page.getByRole('link',{name:'打开画布 复制画布',exact:true}).locator('img');
  await duplicateCover.scrollIntoViewIfNeeded();
  await until(()=>duplicateCover.evaluate(image=>image.complete && image.naturalWidth>0));
  await page.getByRole('button',{name:'新建画布组',exact:true}).click();
  await page.getByRole('textbox',{name:'名称',exact:true}).fill('网页新建组');
  await page.getByRole('dialog').getByRole('button',{name:'新建画布组',exact:true}).click();
  await page.getByRole('heading',{name:'网页新建组',exact:true}).waitFor();
  await page.getByRole('button',{name:'新建画布',exact:true}).click();
  await page.getByRole('textbox',{name:'名称',exact:true}).fill('网页新画布');
  await page.getByRole('dialog').getByRole('button',{name:'新建画布',exact:true}).click();
  await page.getByText('已保存到本机',{exact:true}).waitFor();
  await page.getByRole('button',{name:'添加文字备注',exact:true}).click();
  await page.getByRole('button',{name:'返回工作空间',exact:true}).click();
  await page.getByRole('heading',{name:'工作空间',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'搜索工作空间',exact:true}).fill('网页新画布');
  await page.getByRole('button',{name:'置顶 网页新画布',exact:true}).click();
  await page.getByRole('button',{name:'取消置顶 网页新画布',exact:true}).waitFor();
  await page.getByRole('link',{name:'打开画布 网页新画布',exact:true}).click();
  await page.getByTestId('item-count').getByText(/1 个元素/).waitFor();

  await page.getByRole('button',{name:'返回工作空间',exact:true}).click();
  await page.getByRole('button',{name:'网页新画布的操作',exact:true}).click();
  await page.getByRole('button',{name:'重命名',exact:true}).click();
  await page.getByRole('textbox',{name:'名称',exact:true}).fill('已改名的画布');
  await page.getByRole('dialog').getByRole('button',{name:'重命名',exact:true}).click();
  await page.getByRole('button',{name:'回收画布 已改名的画布',exact:true}).click();
  await page.getByRole('button',{name:'确认回收画布 已改名的画布',exact:true}).click();
  await page.getByRole('link',{name:'打开画布 已改名的画布',exact:true}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'回收站',exact:true}).click();
  await page.getByRole('button',{name:'恢复画布',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'恢复',exact:true}).click();
  await page.getByRole('button',{name:'恢复画布',exact:true}).waitFor({state:'detached'});

  await page.goto(origin+'/?board='+duplicate.id);
  await page.getByText('已保存到本机',{exact:true}).waitFor();
  const clipboard=process.env.MSHTV_TEST_SKIP_NATIVE_CLIPBOARD === '1' ? null : await page.evaluate(async id=>{
    const keys=await (await fetch('/api/v1/session',{method:'POST',headers:{'X-MshTV-Bootstrap':'1'}})).json();
    const suffix='?boardId='+id;
    const capability=await (await fetch('/api/v1/clipboard/capability'+suffix)).json();
    if(!capability.available)return capability;
    const board=await (await fetch('/api/v1/boards/'+id)).json();
    const result=await fetch('/api/v1/clipboard/files'+suffix,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':keys.csrf},
      body:JSON.stringify({revision:board.revision,itemIds:[board.document.items[0].id],groupIds:[]})});
    return result.json();
  },duplicate.id);
  if(clipboard?.available===false)console.log('Clipboard environment: '+clipboard.reason);
  else if(clipboard) assert.equal(clipboard.copied,1);
  assert.deepEqual(errors,[]);
  await page.close();

  await stop(); await start(current);
  sameContent(await snapshot(duplicate.id),saved);
  assert.equal((await roots(independent.id)).find(root=>root.id===newWatch.id).newFilesOnly,true);
  assert.equal((await entries(independent.id))[0].id,sharedAsset.id);
  assert.deepEqual(backups(),backup);
  assert.deepEqual(readFileSync(join(source,'legacy.png')),original);
  console.log('PASS trash, restore, export, workspace navigation, restart and untouched originals');

  const recoveringBoard=await make('boards','离线时移出的画布',g.id);
  await api('/boards/'+recoveringBoard.id+'/mutations',{body:mutation(recoveringBoard.revision,
    [{kind:'putItem',item:{...originalCard,groupId:null}}])});
  const groupRoot=(await roots(peer.id))[0];
  const offline=join(fixture,'source-offline');
  renameSync(source,offline);
  try {
    await api('/library/roots/'+groupRoot.id+'/scan',{board:peer.id,body:{}});
    await until(async()=> (await roots(peer.id)).find(root=>root.id===groupRoot.id)?.online===false);
    assert.equal((await api('/assets/'+originalAsset.id,{board:recoveringBoard.id})).status,'offline');
    await alter('boards',recoveringBoard.id,'move',{groupId:null});
    assert.equal((await send('/media/'+originalAsset.id+'/source',{board:recoveringBoard.id})).status,404);
  } finally { renameSync(offline,source); }
  await api('/library/roots/'+groupRoot.id+'/scan',{board:peer.id,body:{}});
  await until(async()=> (await api('/assets/'+originalAsset.id,{board:peer.id})).status==='ready');
  assert.equal((await api('/assets/'+originalAsset.id,{board:recoveringBoard.id})).status,'ready',
    'An extracted board must regain access when its original folder comes online');
  assert.equal((await snapshot(recoveringBoard.id)).document.items[0].assetId,originalAsset.id);
  assert.deepEqual(Buffer.from(await (await send('/media/'+originalAsset.id+'/source',{board:recoveringBoard.id})).arrayBuffer()),original);
  console.log('PASS media references recover when a folder reconnects after its board moves out');

  const restrictedAsset=indexed.find(a=>a.name==='other.png');
  const restrictedBoard=await make('boards','来源范围测试',g.id);
  await api('/boards/'+restrictedBoard.id+'/mutations',{body:mutation(restrictedBoard.revision,
    [{kind:'putItem',item:card('image',restrictedAsset.id,'来源范围测试图片')}])});
  const separate=join(fixture,'separate-source'); mkdirSync(separate);
  await api('/library/roots',{board:outside.id,body:{path:separate}});
  renameSync(join(source,'other.png'),join(separate,'other.png'));
  await until(async()=> (await entries(outside.id)).some(a=>a.id===restrictedAsset.id&&a.status==='ready'));
  assert.equal((await api('/assets/'+restrictedAsset.id,{board:restrictedBoard.id})).status,'missing');
  await alter('boards',restrictedBoard.id,'move',{groupId:null});
  assert.equal((await send('/media/'+restrictedAsset.id+'/source',{board:restrictedBoard.id})).status,404);
  assert.equal((await send('/media/'+restrictedAsset.id+'/source',{board:outside.id})).status,200);
  console.log('PASS a moved board preserves source boundaries for a file relocated to a different library');

  const purgeBoard=await make('boards','彻底删除测试');
  const groupMate=(await list()).boards.find(board=>board.id===peer.id);
  for(const board of [purgeBoard,groupMate])
    await api('/boards/'+board.id+'/mutations',{body:mutation(board.revision,[{kind:'putItem',item:{...note,groupId:null}}])});
  const active=(await list()).boards.find(board=>board.id===purgeBoard.id);
  assert.equal((await send('/workspace/boards/'+active.id,{method:'PATCH',body:{action:'purge',revision:active.revision}})).status,409);
  const activeGroup=(await list()).groups.find(group=>group.id===g.id);
  assert.equal((await send('/workspace/groups/'+g.id,{method:'PATCH',body:{action:'purge',revision:activeGroup.revision}})).status,409);
  await alter('boards',purgeBoard.id,'delete');
  assert.equal((await send('/workspace/boards/'+active.id,{method:'PATCH',body:{action:'purge',revision:active.revision}})).status,409);
  await alter('boards',first.id,'delete');
  await alter('groups',g.id,'delete');
  assert.equal((await list()).groups.find(group=>group.id===g.id).boardCount,2);

  const trashPage=await browser.newPage();
  await trashPage.goto(origin);
  await trashPage.getByRole('button',{name:'回收站',exact:true}).click();
  const purgeButton=trashPage.getByRole('button',{name:'彻底删除画布 '+purgeBoard.name,exact:true});
  const confirmPurge=trashPage.getByRole('button',{name:'确认彻底删除画布 '+purgeBoard.name,exact:true});
  await purgeButton.click();
  assert.ok((await list()).boards.some(board=>board.id===purgeBoard.id));
  await trashPage.keyboard.press('Escape');
  await purgeButton.waitFor();
  const position=await purgeButton.boundingBox();
  await purgeButton.click();
  assert.deepEqual(await confirmPurge.boundingBox(),position);
  await confirmPurge.click();
  await purgeButton.waitFor({state:'detached'});
  await trashPage.getByRole('button',{name:'彻底删除画布组 '+g.name,exact:true}).click();
  const confirmGroup=trashPage.getByRole('button',{name:'确认彻底删除画布组 '+g.name,exact:true});
  await confirmGroup.getByText('确认删除组及 2 张画布',{exact:true}).waitFor();
  await confirmGroup.click();
  await until(async()=> !(await list()).groups.some(group=>group.id===g.id));
  await trashPage.getByRole('button',{name:'彻底删除画布组 '+g.name,exact:true}).waitFor({state:'detached'});
  await trashPage.close();
  assert.equal((await send('/workspace/boards/'+purgeBoard.id,{method:'PATCH',body:{action:'restore',revision:active.revision+1}})).status,404);
  const afterPurge=await list();
  assert.ok(!afterPurge.groups.some(group=>group.id===g.id));
  assert.ok(!afterPurge.boards.some(board=>[purgeBoard.id,first.id,peer.id].includes(board.id)));
  const applicationCopy=readdirSync(join(data,'imports'))[0];
  assert.deepEqual(readFileSync(join(data,'imports',applicationCopy)),original);
  assert.deepEqual(readFileSync(join(source,'legacy.png')),original);
  assert.deepEqual(Buffer.from(await (await send('/media/'+originalAsset.id+'/source',{board:duplicate.id})).arrayBuffer()),original);
  const purgedDb=new DatabaseSync(join(data,'canvas.db'),{readOnly:true});
  try {
    const receipts=purgedDb.prepare('SELECT count(*) AS n FROM Receipts WHERE Key LIKE ?');
    assert.equal(receipts.get(purgeBoard.id+':%').n,0);
    assert.equal(receipts.get(peer.id+':%').n,0);
    assert.equal(purgedDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally {purgedDb.close();}
  console.log('PASS permanent board and group deletion, confirmation, revision checks and preserved shared media');

  await stop();
  const broken=join(fixture,'failed-migration'), restored=join(fixture,'restored-backup');
  mkdirSync(broken); mkdirSync(restored);
  copyFileSync(join(data,backup[0]),join(broken,'canvas.db'));
  const fault=new DatabaseSync(join(broken,'canvas.db'));
  try { fault.exec('CREATE TABLE LibraryMembers (Id TEXT PRIMARY KEY)'); } finally { fault.close(); }
  let failure='';
  await launch(current,broken,chunk=>failure+=chunk.toString());
  const failed=await until(()=> processHandle.exitCode!==null && {code:processHandle.exitCode},15);
  assert.notEqual(failed.code,0);
  assert.match(failure,/table LibraryMembers already exists/);
  assert.equal(await fetch(origin+'/api/v1/health').then(()=>true).catch(()=>false),false);
  const failedDb=new DatabaseSync(join(broken,'canvas.db'),{readOnly:true});
  try {
    assert.equal(failedDb.prepare("SELECT count(*) AS n FROM pragma_table_info('Boards') WHERE name='LibraryId'").get().n,0);
    assert.equal(failedDb.prepare('SELECT Revision FROM Boards WHERE Id=?').get('main').Revision,saved.revision);
    assert.equal(failedDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally { failedDb.close(); }
  const rollbackBackup=readdirSync(broken).find(x=>x.startsWith('before-workspace-')&&x.endsWith('.db'));
  assert.ok(rollbackBackup);
  copyFileSync(join(broken,rollbackBackup),join(restored,'canvas.db'));
  await start(legacy,restored);
  sameContent(await snapshot('main'),saved);
  assert.equal((await roots('main'))[0].id,oldRoot.id);
  console.log('PASS migration failure rolls back and its backup opens with the legacy server');

  await stop();
  const walDirectory=join(fixture,'wal-only'); mkdirSync(walDirectory);
  const walPath=join(walDirectory,'canvas.db');
  const wal=new DatabaseSync(walPath);
  try {
    wal.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE LegacyMarker(Value TEXT); INSERT INTO LegacyMarker VALUES ('unsynced fixture');");
    assert.equal(statSync(walPath).size,4096);
    await start(current,walDirectory);
    const name=readdirSync(walDirectory).find(x=>x.startsWith('before-workspace-')&&x.endsWith('.db'));
    assert.ok(name);
    const copy=new DatabaseSync(join(walDirectory,name),{readOnly:true});
    try {
      assert.equal(copy.prepare('SELECT Value FROM LegacyMarker').get().Value,'unsynced fixture');
      assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
    } finally { copy.close(); }
  } finally { wal.close(); }
  console.log('PASS pre-migration backup includes WAL-only data');

  await stop();
  const empty=join(fixture,'empty-workspace'); mkdirSync(empty);
  await start(current,empty);
  assert.deepEqual((await list()).boards.map(board=>board.id),['main']);
  await alter('boards','main','delete');
  await alter('boards','main','purge');
  await stop(); await start(current,empty);
  assert.deepEqual((await list()).boards,[]);
  console.log('PASS a permanently deleted last board stays deleted after restart');
} finally { await browser?.close(); await stop(); }
