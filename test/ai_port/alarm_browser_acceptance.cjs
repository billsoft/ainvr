// AINVR browser acceptance runner. Credentials arrive on stdin only, never logs.
// Uses an installed isolated browser context; does not read an existing profile.
const path=require('node:path'),readline=require('node:readline'),fs=require('node:fs');
const respond=value=>{fs.writeFileSync(process.env.AINVR_BROWSER_RESULT,JSON.stringify(value,null,2));process.stdout.write('browser-result-ready\n');};
const {chromium}=require(path.join(process.env.AINVR_BROWSER_NODE_MODULES,'playwright'));
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.AINVR_BROWSER_EXECUTABLE,headless:true});
 const context=await browser.newContext({viewport:{width:1366,height:900},hasTouch:true});
 const page=await context.newPage();
 let confirmText=null;const dialogs=[],errors=[];
 page.on('dialog',async d=>{dialogs.push({type:d.type(),message:d.message()});if(confirmText===d.message())await d.accept();else await d.dismiss();});
 page.on('pageerror',e=>errors.push(String(e.message).slice(0,300)));

 const state=async()=>({url:page.url(),dialogs,errors,text:(await page.locator('body').innerText()).slice(0,22000),elements:await page.locator('a,button,input,select,textarea').evaluateAll(nodes=>nodes.filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>({tag:e.tagName,role:e.getAttribute('role'),text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,200),label:e.labels?.[0]?.innerText||e.getAttribute('aria-label'),type:e.type,name:e.name,placeholder:e.getAttribute('placeholder'),value:e.type==='password'?'[masked]':e.value,disabled:e.disabled,checked:e.checked}))) });
 if(process.stdin.isTTY)process.stdin.setRawMode(true);
 process.stdout.write(JSON.stringify({ready:true})+'\n');
 for await(const line of readline.createInterface({input:process.stdin,terminal:false})){
  let op;
  try{
   op=JSON.parse(line);confirmText=op.confirmText??null;let result;
   const element=()=>op.label?page.getByLabel(op.label,{exact:op.exact!==false}):op.role?page.getByRole(op.role,{name:op.name,exact:op.exact!==false}):page.locator(op.selector);
   if(op.op==='goto'){await page.goto(op.url,{waitUntil:'domcontentloaded'});await page.locator('#root > *').first().waitFor();}
   else if(op.op==='click')await element().click();
   else if(op.op==='point'){const b=await element().boundingBox();if(!b)throw Error('No visible geometry');await page.mouse.click(b.x+b.width*op.x,b.y+b.height*op.y);}
   else if(op.op==='drag'){const b=await element().boundingBox();if(!b)throw Error('No visible geometry');await page.mouse.move(b.x+b.width*op.x,b.y+b.height*op.y);await page.mouse.down();await page.mouse.move(b.x+b.width*op.toX,b.y+b.height*op.toY,{steps:8});await page.mouse.up();}
   else if(op.op==='fill')await element().fill(op.value);
   else if(op.op==='check')await element().setChecked(op.checked??true);
   else if(op.op==='select')await element().selectOption(op.value);
   else if(op.op==='key')await page.keyboard.press(op.key);
   else if(op.op==='viewport')await page.setViewportSize(op.size);
   else if(op.op==='screenshot'){await page.screenshot({path:op.path,fullPage:true});result={screenshot:op.path};}
   else if(op.op==='wait')await page.getByText(op.text,{exact:op.exact??false}).first().waitFor({timeout:op.timeout??10000});
   else if(op.op==='close'){await context.close();await browser.close();process.stdout.write(JSON.stringify({closed:true})+'\n');break;}
   else if(op.op!=='state')throw Error('Unknown browser test operation');
   respond(result??await state());
  }catch(e){respond({error:op?.sensitive?'Sensitive action failed; no details logged':String(e.message).slice(0,2500)});}
 }
 await browser.close();
})().catch(()=>{process.stderr.write('Isolated browser runner failed\n');process.exitCode=1;});
