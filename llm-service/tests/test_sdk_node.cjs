// Credentials arrive only over stdin, never in argv or a saved file.
const OpenAI = require('/mnt/ainvr-ssd/llm-build/sdk-node/node_modules/openai');
(async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const {key, request} = JSON.parse(input);
  const client = new OpenAI({apiKey:key,baseURL:'http://127.0.0.1:8300/v1',maxRetries:0,timeout:75000});
  const result = await client.chat.completions.create({model:'qwen3vl-4b-review-v3',messages:[],ainvr:{decision:request}});
  console.log(JSON.stringify({logits:result.ainvr.logits,request_id:result.ainvr.request_id}));
})().catch(error => { console.error(error.name, error.status || 'request failed'); process.exitCode=1; });
