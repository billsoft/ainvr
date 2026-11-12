const {chromium}=require(process.env.AINVR_BROWSER_MODULE || 'playwright-core');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const root=process.env.AINVR_UI_RESULTS || './vehicle-ui-results';
fs.mkdirSync(root,{recursive:true});
const base=process.env.AINVR_UI_URL || 'http://192.168.100.190:5186/vehicle-demo.html';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.AINVR_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1366,height:768},timezoneId:'Asia/Shanghai'});
 const errors=[],api=[],steps=[],layouts=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api'))api.push(r.url())});
 const click=async text=>page.getByRole('button',{name:text,exact:true}).click();
 const nav=async text=>page.locator('.vd-sidebar').getByRole('button',{name:text,exact:false}).click();
 const shot=async name=>page.screenshot({path:`${root}/${name}.png`,fullPage:true});
 const checked=(name)=>{steps.push(name);console.log('PASS '+name)};
 try{
 await page.goto(base);
 await page.getByRole('heading',{name:'统计分析',exact:true}).waitFor();
 for(const [w,h] of [[1366,768],[1180,820],[1920,1080]]){
  await page.setViewportSize({width:w,height:h});await page.waitForTimeout(100);
  const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
  layouts.push(size);assert(size.scrollWidth<=w,`horizontal overflow ${w}`);assert(size.scrollHeight<=h+2,`overview overflow ${w}: ${size.scrollHeight}`);await shot(`overview-${w}`);
  await click('热区');await shot(`heat-${w}`);await click('总览');
 }
 checked('three desktop sizes: full overview and heat map');
 await page.setViewportSize({width:1366,height:768});
 await page.getByRole('button',{name:'查看东门入口',exact:true}).click();
 assert.equal(await page.getByLabel('位置筛选').inputValue(),'东门入口');assert.equal(await page.locator('tbody tr').count(),10);checked('map drill-down retains scope and correct rows');
 await page.getByLabel('搜索车牌').fill('不存在');await page.getByRole('heading',{name:'此范围没有通行记录'}).waitFor();await shot('empty-state');await page.getByLabel('重置筛选').click();
 await page.getByLabel('识别状态',{exact:true}).selectOption('未检出车牌');assert.equal(await page.locator('tbody tr').count(),1);await page.getByLabel('识别状态',{exact:true}).selectOption('');checked('unread plate and empty filters');
 await shot('records-1366');
 await page.getByRole('button',{name:'详情',exact:false}).first().click();await shot('passage-detail');await click('关联录像');await page.getByText('录像交互占位：',{exact:false}).waitFor();await click('修正车牌');
 await page.getByLabel('车牌号码').fill('京A99881');await page.getByLabel('修正原因').fill('依据示例最佳帧核对');
 await page.getByRole('dialog',{name:'修正车牌',exact:true}).getByLabel('关闭',{exact:true}).click();
 await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await page.getByLabel('车牌号码').inputValue(),'京A99881');await click('保存修正');await page.getByRole('heading',{name:'京A99881',exact:true}).waitFor();await click('关闭详情');
 await page.getByLabel('搜索车牌').fill('99881');assert.equal(await page.locator('tbody tr').count(),1);await page.getByLabel('重置筛选').click();checked('correction keeps draft on cancel and updates retrieval');
 const downloadPromise=page.waitForEvent('download');await click('导出 CSV');const download=await downloadPromise;await download.saveAs(`${root}/example-export.csv`);assert(fs.readFileSync(`${root}/example-export.csv`,'utf8').includes('京A99881'));checked('export uses current records');
 assert.equal(await page.getByRole('button',{name:'检测截图',exact:true}).count(),0);
 await nav('统计分析');assert.equal(await page.getByRole('button',{name:'识别质量',exact:true}).count(),0);assert(await page.locator('.vd-quality-summary').isVisible());await click('编辑平面图');await page.getByLabel('位置x',{exact:true}).fill('210');await page.getByLabel('位置x',{exact:true}).press('Tab');
 await page.getByRole('dialog',{name:'编辑平面图 · 仅规划展示位置'}).getByLabel('关闭',{exact:true}).click();await click('继续编辑');await shot('plan-editor');await click('保存预览布局');
 const fixture=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1600;c.height=900;const x=c.getContext('2d');x.fillStyle='#e9eff3';x.fillRect(0,0,1600,900);x.strokeStyle='#8198ac';x.lineWidth=12;x.strokeRect(8,8,1584,884);x.fillStyle='#cad8e2';x.fillRect(500,100,600,280);x.fillStyle='#8094a8';x.font='38px sans-serif';x.fillText('TEST FLOOR PLAN - ALL FOUR EDGES VISIBLE',240,820);return c.toDataURL().split(',')[1]});fs.writeFileSync(`${root}/floor-plan-fixture.png`,Buffer.from(fixture,'base64'));await click('编辑平面图');await page.locator('input[type=file]').setInputFiles(`${root}/floor-plan-fixture.png`);await click('保存预览布局');await shot('custom-floor-plan');assert.equal(await page.locator('.vd-plan image').count(),1);checked('custom floor plan is centered and retained with independent heat layer');
 await click('告警');await page.getByRole('button',{name:'查看东门入口',exact:true}).click();assert.equal(await page.getByLabel('位置筛选').inputValue(),'东门入口');await shot('alarms');await page.getByRole('button',{name:'证据与审核',exact:true}).first().click();await click('判为误报');await click('关闭详情');await click('已审核');assert((await page.locator('.vd-alarm').count())>=1);checked('map alarm layer and manual rejection preserve passage');
 await nav('AI 通道');await click('设置车辆能力');await shot('channel-capabilities');await page.getByRole('checkbox',{name:'识别车牌',exact:false}).uncheck();await click('取消');await click('继续编辑');assert.equal(await page.getByRole('checkbox',{name:'识别车牌',exact:false}).isChecked(),false);await page.getByRole('checkbox',{name:'识别车牌',exact:false}).check();await click('保存到预览');await page.getByText('预览配置已保存 · 未启用真实模型',{exact:true}).waitFor();checked('single-page capability settings and draft protection');
 await nav('流量统计');await click('新建计数器');const counter=page.getByRole('dialog',{name:'新建计数器'});await counter.getByLabel('名称',{exact:true}).fill('车辆双线计数');await counter.getByRole('button',{name:'汽车',exact:true}).click();await counter.getByRole('radio',{name:'依次经过两条线',exact:false}).click();await shot('counter-editor');await counter.getByRole('button',{name:'保存',exact:true}).click();
 await page.locator('tr').filter({hasText:'车辆双线计数'}).getByRole('button',{name:'布防绑定'}).click();await page.getByLabel('计数边 / 起始边').selectOption('上边');assert(await page.getByRole('button',{name:'保存预览绑定'}).isDisabled());await page.getByLabel('结束边').selectOption('下边');await shot('counter-binding');await click('保存预览绑定');checked('existing counter editor and binding direction validation');
 await nav('告警触发');await click('新建车辆规则');await page.getByLabel('规则名称').fill('多车同时进入');await page.getByLabel('触发条件').selectOption('车辆同时出现');await page.getByLabel('最少目标数').fill('3');await page.getByLabel('同时满足的容许漏检（秒）').fill('1');await shot('rule-editor');await click('保存预览规则');await page.getByText('多车同时进入',{exact:true}).waitFor();checked('group count rule preview');
 await nav('系统配置');await click('添加关注车牌');await page.getByLabel('车牌',{exact:true}).fill('京A12345');await click('添加到预览');await page.getByRole('alert').filter({hasText:'此车牌已在关注名单中'}).waitFor();await page.getByLabel('车牌',{exact:true}).fill('沪B99321');await click('添加到预览');await page.getByText('沪B99321',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'存储与能力',exact:true}).count(),0);await shot('watchlist');checked('normalized duplicate protection without duplicate storage settings');
 await nav('统计分析');await page.getByLabel('重置筛选').click();await click('昨天');assert((await page.locator('.vd-kpis button').first().innerText()).includes('18'));await page.getByRole('button',{name:'选择时间范围',exact:true}).click();await shot('shared-time-picker');await page.keyboard.press('Escape');checked('shared date picker and prior-day range');
 assert.deepEqual(errors,[]);assert.deepEqual(api,[]);checked('no browser exceptions or production API calls');
 fs.writeFileSync(`${root}/browser-results.json`,JSON.stringify({status:'passed',steps,layouts,errors,api},null,2));
 }catch(e){await shot('failure');fs.writeFileSync(`${root}/browser-results.json`,JSON.stringify({status:'failed',error:String(e),steps,layouts,errors,api},null,2));throw e}
 finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
