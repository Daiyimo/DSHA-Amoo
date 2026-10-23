'use strict';
// MCP 只桥接已存在的 Android 设备接口；不暴露 shell、凭据读取或任意文件访问。
const fs=require('node:fs/promises');
const {execFile,spawnSync}=require('node:child_process');
const os=require('node:os');
const path=require('node:path');
const MAX_SCREENSHOT_BYTES=16*1024*1024;
const definitions=[
  ['android_screenshot','【默认观察方式】截取当前屏幕并把图片放进上下文：交给视觉模型（step-5-preview）识别要操作的元素，再用 android_click 按图中坐标点按。需要系统截屏能力和 DSHA 授权。','/app/ui/screenshot',{}],
  ['android_click','按坐标点击；坐标必须来自最近一次观察——优先取截图中识别出的元素位置。','/app/ui/tap',{x:{type:'integer',minimum:0},y:{type:'integer',minimum:0}}],
  ['android_type','向已聚焦输入框写入文字。涉及敏感操作时先取得用户确认。','/app/ui/input',{text:{type:'string',maxLength:2000}}],
  ['android_key','按下 Android 导航键。','/app/ui/key',{name:{type:'string',enum:['back','home','recents','notifications','quicksettings']}}],
  ['android_swipe','在观察过的页面上滑动。','/app/ui/swipe',{x1:{type:'integer',minimum:0},y1:{type:'integer',minimum:0},x2:{type:'integer',minimum:0},y2:{type:'integer',minimum:0},ms:{type:'integer',minimum:50,maximum:3000}}],
  ['android_get_state','【兜底观察方式】读取控件树（每项带文字与中心坐标）。仅当截图识别失败、需要精确文字匹配、或元素没有视觉特征时使用；用返回的中心坐标配合 android_click 点按。','/app/ui/dump',{}]
];
const tools=definitions.map(([name,description,,properties])=>({name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}));
// android_click 额外暴露 index（与 {x,y} 二选一）；validate 仍只认 x,y，index 在 call() 里解析成框中心。
const clickTool=tools.find(t=>t.name==='android_click');
clickTool.description='按坐标点击（坐标取最近一次观察）；或用最近一次 android_detect_ui 返回的序号 index 点击该元素中心（坐标来自检测框，比目测准）。';
clickTool.inputSchema={type:'object',properties:{x:{type:'integer',minimum:0},y:{type:'integer',minimum:0},index:{type:'integer',minimum:1}},required:[],additionalProperties:false};
tools.push({name:'android_detect_ui',description:'【精确定位】检测屏幕可点元素，返回同帧截图与带序号框清单（类别+中心坐标）。用于控件树读不到（WebView/游戏）或对目测坐标没把握时；按返回序号用 android_click(index=N) 点击其中心，不要输出肉眼估计的像素坐标。',inputSchema:{type:'object',properties:{conf:{type:'number',minimum:0.1,maximum:0.9}},required:[],additionalProperties:false}});
// ---- ui-detect：容器内 YOLO 检测。资产经 managed-runtime-inputs 的 installs 装到 /root/.dsha/ui-detect/；
//      首次 detect 用随包 wheel 离线 pip 自建 site（marker 防重），无网络、无设备代码改动。----
const fsSync=require('node:fs');
const DETECT_DIR='/root/.dsha/ui-detect';
const DETECT_SITE=DETECT_DIR+'/site';
const DETECT_WHEELS=DETECT_DIR+'/wheels';
const DETECT_SCRIPT=DETECT_DIR+'/ui_detect.py';
const DETECT_MODEL=DETECT_DIR+'/yolov8n-ui.onnx';
const DETECT_MARKER=DETECT_SITE+'/.ready';
// 免 pip 解压引导：只解与当前 python 兼容的 wheel（纯包/abi3/精确 cp 版本），跳过不兼容的残留 wheel。
const DETECT_EXTRACT='import sys,glob,os,zipfile\nsite,wheels=sys.argv[1],sys.argv[2]\npy="cp%d%d"%sys.version_info[:2]\ndef ok(w):\n return ("none-any" in w) or ("abi3" in w) or (py in w)\nn=0\nfor whl in sorted(glob.glob(os.path.join(wheels,"*.whl"))):\n if not ok(os.path.basename(whl)): continue\n with zipfile.ZipFile(whl) as z:\n  for name in z.namelist():\n   if name.endswith("/"): continue\n   parts=name.split("/"); rel=name\n   for i,p in enumerate(parts):\n    if p.endswith(".data") and i+1<len(parts) and parts[i+1] in ("purelib","platlib"):\n     rel="/".join(parts[i+2:]); break\n   if not rel or rel.startswith("/") or ".." in rel.split("/"): continue\n   dst=os.path.join(site,rel); os.makedirs(os.path.dirname(dst),exist_ok=True)\n   with z.open(name) as s,open(dst,"wb") as d: d.write(s.read())\n n+=1\nprint("extracted",n,"wheels for",py)\n';
let lastDetect=[];
function resolveClickIndex(boxes,index){if(!Number.isInteger(index)||index<1)throw Error('INVALID_index');const box=(boxes||[]).find(item=>item.index===index);if(!box)throw Error('DETECT_STALE');return {x:box.cx,y:box.cy};}
function parseDetectorOutput(stdout){let boxes;try{boxes=JSON.parse(stdout);}catch{throw Error('DETECT_OUTPUT_INVALID');}if(!Array.isArray(boxes)||boxes.some(item=>!Number.isInteger(item.index)||!Number.isInteger(item.cx)||!Number.isInteger(item.cy)))throw Error('DETECT_OUTPUT_INVALID');return boxes;}
function ensureSite(){if(fsSync.existsSync(DETECT_MARKER))return;
  for(const p of [DETECT_SCRIPT,DETECT_MODEL,DETECT_WHEELS])if(!fsSync.existsSync(p)){const e=Error('DETECT_ASSETS_MISSING');e.detail='缺少 '+p+'（installs 未落盘？）';throw e;}
  fsSync.mkdirSync(DETECT_SITE,{recursive:true});
  const done=spawnSync('python3',['-c',DETECT_EXTRACT,DETECT_SITE,DETECT_WHEELS],{timeout:120000,stdio:['ignore','pipe','pipe']});
  if(done.error||done.status!==0){const e=Error('DETECT_RUNTIME_UNAVAILABLE');e.detail=(done.stderr||'').toString().trim().split('\n').slice(-3).join(' | ')||('python3 退出码 '+done.status);throw e;}
  const smoke=spawnSync('python3',['-c','import onnxruntime,numpy,PIL'],{env:{...process.env,PYTHONPATH:DETECT_SITE},timeout:60000,stdio:['ignore','pipe','pipe']});
  if(smoke.error||smoke.status!==0){const e=Error('DETECT_IMPORT_FAILED');e.detail=(smoke.stderr||'').toString().trim().split('\n').slice(-4).join(' | ')||('import 失败');throw e;}
  fsSync.writeFileSync(DETECT_MARKER,'ok\n');
}
function runPython(cmd,args,opts){return new Promise((resolve,reject)=>{const child=execFile(cmd,args,opts,(error,stdout)=>{if(error)reject(Object.assign(error,{stderr}));else resolve(stdout);});if(opts.signal){if(opts.signal.aborted)child.kill();opts.signal.addEventListener('abort',()=>child.kill(),{once:true});}});}
async function runDetector(imgPath,conf,signal){ensureSite();let stdout;try{stdout=await runPython('python3',[DETECT_SCRIPT,imgPath,DETECT_MODEL,String(conf)],{env:{...process.env,PYTHONPATH:DETECT_SITE},timeout:20000,maxBuffer:8*1024*1024,signal});}catch(error){throw Error('DETECT_RUNTIME_UNAVAILABLE');}return parseDetectorOutput(stdout);}
function pngSize(b64){const b=Buffer.from(b64,'base64');return {w:b.readUInt32BE(16),h:b.readUInt32BE(20)};}
async function detectUi(args,signal,dependencies){
  if(args&&Object.keys(args).some(key=>key!=='conf'))throw Error('UNKNOWN_ARGUMENT');
  const conf=args&&args.conf!==undefined?args.conf:0.5;
  if(typeof conf!=='number'||!Number.isFinite(conf)||conf<0.1||conf>0.9)throw Error('INVALID_conf');
  const shot=await call('android_screenshot',{},signal,dependencies);
  if(shot.isError)return shot;
  const image=shot.content.find(part=>part.type==='image');
  if(!image||typeof image.data!=='string')throw Error('SCREENSHOT_UNAVAILABLE');
  const size=pngSize(image.data);
  const tmp=path.join(os.tmpdir(),'dsha-ui-'+process.pid+'-'+Date.now()+'.png');
  await dependencies.fs.writeFile(tmp,Buffer.from(image.data,'base64'));
  let boxes;
  try{boxes=await runDetector(tmp,conf,signal);}
  finally{try{await dependencies.fs.unlink(tmp);}catch{}}
  // clamp 到屏幕内，避免越界坐标被 dispatchGesture 静默丢弃
  for(const item of boxes){item.cx=Math.max(0,Math.min(size.w-1,item.cx));item.cy=Math.max(0,Math.min(size.h-1,item.cy));}
  lastDetect=boxes;
  const text=boxes.length
    ?'检测到 '+boxes.length+' 个可点元素（下方为同帧截图；按序号用 android_click(index=N) 点击其中心）：\n'+boxes.map(item=>'#'+item.index+' '+item.cls+' conf='+item.conf+' center=('+item.cx+','+item.cy+')').join('\n')
    :'未检测到可点元素。回退：用 android_get_state 读控件树，或按截图坐标 android_click(x,y)。';
  return {content:[{type:'text',text},image],isError:false};
}
function validate(def,args){if(!args||typeof args!=='object'||Array.isArray(args))throw Error('INVALID_ARGUMENTS');const fields=def[3];if(Object.keys(args).some(k=>!Object.hasOwn(fields,k)))throw Error('UNKNOWN_ARGUMENT');for(const [key,rule]of Object.entries(fields)){const v=args[key];if(rule.type==='integer'&&(!Number.isInteger(v)||v<rule.minimum||rule.maximum!==undefined&&v>rule.maximum))throw Error('INVALID_'+key);if(rule.type==='string'&&(typeof v!=='string'||rule.maxLength&&v.length>rule.maxLength||rule.enum&&!rule.enum.includes(v)))throw Error('INVALID_'+key);}}
// 只识别桥返回的错误前缀；读屏正文可能包含终端日志里的 [ERR] 等普通文字。
function bridgeFailed(result){return /^\s*(?:\[ERR\]|\[?(?:POLICY_BLOCKED|EXECUTION_UNKNOWN|NO_PERMISSION|DISABLED|UNAUTHORIZED)\b)/.test(result);}
// Native capture returns the freshly generated PNG directly: the guest does not
// necessarily mount the current Android user's /storage/emulated/<id> directory.
function screenshotContent(result){let shot;try{shot=JSON.parse(result);}catch{throw Error('SCREENSHOT_RESPONSE_INVALID');}
  if(shot?.kind!=='dsha-screenshot-v1'||shot.mimeType!=='image/png'||typeof shot.data!=='string')throw Error('SCREENSHOT_RESPONSE_INVALID');
  if(shot.data.length>Math.ceil(MAX_SCREENSHOT_BYTES/3)*4)throw Error('SCREENSHOT_TOO_LARGE');
  const png=Buffer.from(shot.data,'base64');
  if(png.toString('base64')!==shot.data)throw Error('SCREENSHOT_RESPONSE_INVALID');
  if(png.length>MAX_SCREENSHOT_BYTES)throw Error('SCREENSHOT_TOO_LARGE');
  if(png.length<8||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('SCREENSHOT_RESPONSE_INVALID');
  const text=typeof shot.path==='string'?'Screenshot saved: '+shot.path:'Android screenshot';
  return [{type:'text',text},{type:'image',mimeType:'image/png',data:shot.data}];
}
async function call(name,args,signal,dependencies={fs,fetch:globalThis.fetch}){if(name==='android_detect_ui')return await detectUi(args,signal,dependencies);const def=definitions.find(t=>t[0]===name);if(!def)throw Error('UNKNOWN_TOOL');if(name==='android_click'&&args&&Object.hasOwn(args,'index')){if(Object.keys(args).some(key=>key!=='index'))throw Error('UNKNOWN_ARGUMENT');const resolved=resolveClickIndex(lastDetect,args.index);args={x:resolved.x,y:resolved.y};}validate(def,args);
  const token=(await dependencies.fs.readFile('/root/.dsh/.bridge_token','utf8')).trim();if(!token)throw Error('BRIDGE_NOT_READY');
  const url=new URL('http://127.0.0.1:3090'+def[2]);for(const [k,v]of Object.entries(args))url.searchParams.set(k,String(v));
  if(name==='android_screenshot')url.searchParams.set('format','mcp');
  const response=await dependencies.fetch(url,{signal,headers:{'X-Token':token}});if(!response.ok)throw Error('BRIDGE_HTTP_'+response.status);
  const raw=await readBridgeResponse(response,name==='android_screenshot'?24*1024*1024:2*1024*1024);let result=raw;try{const parsed=JSON.parse(raw);result=typeof parsed.result==='string'?parsed.result:raw;}catch{}
  const failed=bridgeFailed(result);
  const content=name==='android_screenshot'&&!failed?screenshotContent(result):[{type:'text',text:result}];
  if(!failed&&(name==='android_click'||name==='android_type'||name==='android_key'||name==='android_swipe'))lastDetect=[]; // 画面可能已变，废掉旧序号
  return {content,isError:failed};
}
async function readBridgeResponse(response,limit){
  const advertised=Number(response.headers.get('content-length'));
  if(Number.isFinite(advertised)&&advertised>limit){await response.body?.cancel();throw Error('BRIDGE_RESPONSE_TOO_LARGE');}
  if(!response.body) return '';
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Error('BRIDGE_RESPONSE_TOO_LARGE');}parts.push(value);}}
  finally{reader.releaseLock();}
  return Buffer.concat(parts,size).toString('utf8');
}
function startServer(){
const active=new Map(),cancelled=new Set();let buffer='',queue=Promise.resolve(),ended=false,pending=0;
const send=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
async function receive(message){const {id,method,params={}}=message;if(method==='notifications/cancelled'){if(active.has(params.requestId))active.get(params.requestId).abort();else if(cancelled.size<128)cancelled.add(params.requestId);return;}if(id===undefined)return;if(ended||cancelled.delete(id)){send({id,error:{code:-32800,message:'Request cancelled before execution'}});return;}
  try{let result;
    if(method==='initialize')result={protocolVersion:params.protocolVersion||'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'DSHA Android Computer Use',version:'0.1.0'},instructions:'Localize in this order, do not skip: (1) android_get_state for the control tree - if it has readable nodes, click by text/center with android_click (most reliable). (2) If the tree is empty (self-drawn UIs like WeChat, WebView, mini-games always return no readable nodes), do NOT estimate pixel coordinates by eye - call android_detect_ui and click the returned index with android_click(index=N); visual coordinate estimation is unreliable (measured ~100-420px vertical misses). (3) Only fall back to android_click(x,y) from a fresh screenshot when detect finds no clickable element or the target is plain background. Use a fresh observation before every action and verify afterwards. Respect native permission and confirmation results. Never replay an action whose outcome is unknown.'};
    else if(method==='ping')result={};
    else if(method==='tools/list')result={tools};
    else if(method==='tools/call'){const controller=new AbortController();active.set(id,controller);try{result=await call(params.name,params.arguments||{},controller.signal);}finally{active.delete(id);}}
    else{send({id,error:{code:-32601,message:'Method not found'}});return;}
    send({id,result});
  }catch(error){const code=String(error.code||(/^[A-Z][A-Za-z0-9_]{0,60}$/.test(error.message)?error.message:'OPERATION_UNAVAILABLE'));const hint=({DETECT_STALE:'序号已失效（画面可能已变）。请重新 android_detect_ui 再点。',INVALID_index:'index 必须取最近一次 detect 返回的正整数序号。',DETECT_ASSETS_MISSING:'UI 检测资产未安装到容器（installs 未落盘）。回退：android_get_state 或按截图坐标 android_click。',DETECT_IMPORT_FAILED:'UI 检测依赖 import 失败（python 与 onnxruntime/numpy ABI 可能不匹配）。回退：android_get_state 或按截图坐标 android_click。',DETECT_RUNTIME_UNAVAILABLE:'UI 检测运行时不可用（容器内 python3 缺失或首次解压失败）。回退：用 android_get_state 读控件树，或按截图坐标 android_click(x,y)。',DETECT_OUTPUT_INVALID:'检测输出异常，请重试 android_detect_ui。',SCREENSHOT_UNAVAILABLE:'取屏失败，无法检测；重试或回退。'})[code];const detail=error.detail?(' 详情: '+error.detail):'';send({id,result:{content:[{type:'text',text:(hint||('Android operation unavailable: '+code+'. Check DSHA device permissions. If execution may have started, verify the screen before retrying.'))+detail}],isError:true}});}
}
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>1024*1024){process.stderr.write('MCP_INPUT_LIMIT\n');process.exit(1);}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;let value;try{value=JSON.parse(line);}catch{send({id:null,error:{code:-32700,message:'Parse error'}});continue;}if(value.method==='notifications/cancelled')void receive(value);else if(pending>=32)send({id:value.id??null,error:{code:-32000,message:'Request queue full'}});else{pending++;queue=queue.then(()=>receive(value)).finally(()=>pending--);}}});
process.stdin.on('end',()=>{ended=true;for(const controller of active.values())controller.abort();});
process.stdout.on('error',error=>{if(error.code==='EPIPE')process.exit(0);});
}
if(require.main===module)startServer();
module.exports={validate,definitions,tools,bridgeFailed,screenshotContent,readBridgeResponse,call,resolveClickIndex,parseDetectorOutput,runDetector};
