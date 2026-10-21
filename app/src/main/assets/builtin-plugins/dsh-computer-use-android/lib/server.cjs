'use strict';
// MCP 只桥接已存在的 Android 设备接口；不暴露 shell、凭据读取或任意文件访问。
const fs=require('node:fs/promises');
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
async function call(name,args,signal,dependencies={fs,fetch:globalThis.fetch}){const def=definitions.find(t=>t[0]===name);if(!def)throw Error('UNKNOWN_TOOL');validate(def,args);
  const token=(await dependencies.fs.readFile('/root/.dsh/.bridge_token','utf8')).trim();if(!token)throw Error('BRIDGE_NOT_READY');
  const url=new URL('http://127.0.0.1:3090'+def[2]);for(const [k,v]of Object.entries(args))url.searchParams.set(k,String(v));
  if(name==='android_screenshot')url.searchParams.set('format','mcp');
  const response=await dependencies.fetch(url,{signal,headers:{'X-Token':token}});if(!response.ok)throw Error('BRIDGE_HTTP_'+response.status);
  const raw=await readBridgeResponse(response,name==='android_screenshot'?24*1024*1024:2*1024*1024);let result=raw;try{const parsed=JSON.parse(raw);result=typeof parsed.result==='string'?parsed.result:raw;}catch{}
  const failed=bridgeFailed(result);
  const content=name==='android_screenshot'&&!failed?screenshotContent(result):[{type:'text',text:result}];
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
    if(method==='initialize')result={protocolVersion:params.protocolVersion||'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'DSHA Android Computer Use',version:'0.1.0'},instructions:'Default to visual operation: observe with android_screenshot, identify the target element in the image, then act by coordinates with android_click. Fall back to the accessibility tree (android_get_state) only when visual recognition fails, exact text matching is needed, or an element has no visual features. Use a fresh observation before every action and verify afterwards. Respect native permission and confirmation results. Never replay an action whose outcome is unknown.'};
    else if(method==='ping')result={};
    else if(method==='tools/list')result={tools};
    else if(method==='tools/call'){const controller=new AbortController();active.set(id,controller);try{result=await call(params.name,params.arguments||{},controller.signal);}finally{active.delete(id);}}
    else{send({id,error:{code:-32601,message:'Method not found'}});return;}
    send({id,result});
  }catch(error){send({id,result:{content:[{type:'text',text:'Android operation unavailable: '+String(error.code||(/^[A-Z][A-Za-z0-9_]{0,60}$/.test(error.message)?error.message:'OPERATION_UNAVAILABLE'))+'. Check DSHA device permissions. If execution may have started, verify the screen before retrying.'}],isError:true}});}
}
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>1024*1024){process.stderr.write('MCP_INPUT_LIMIT\n');process.exit(1);}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;let value;try{value=JSON.parse(line);}catch{send({id:null,error:{code:-32700,message:'Parse error'}});continue;}if(value.method==='notifications/cancelled')void receive(value);else if(pending>=32)send({id:value.id??null,error:{code:-32000,message:'Request queue full'}});else{pending++;queue=queue.then(()=>receive(value)).finally(()=>pending--);}}});
process.stdin.on('end',()=>{ended=true;for(const controller of active.values())controller.abort();});
process.stdout.on('error',error=>{if(error.code==='EPIPE')process.exit(0);});
}
if(require.main===module)startServer();
module.exports={validate,definitions,tools,bridgeFailed,screenshotContent,readBridgeResponse,call};
