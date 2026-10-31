// Run only against the temporary loopback Mongo fixture; never production.
import {spawn} from 'node:child_process';
const uri='mongodb://127.0.0.1:27029';
const files=['test/dwell-mongo.test.mjs','test/region-heat-mongo.test.mjs','test/flow-measured-mongo.test.mjs','test/alarm-range-statistics-mongo.test.mjs'];
const child=spawn(process.execPath,['--test','--test-concurrency=1',...files],{cwd:'/home/sunrise/ainvr/alarm-service',stdio:'inherit',env:{...process.env,AINVR_DWELL_TEST_MONGO_URI:uri,AINVR_HEAT_TEST_MONGO_URI:uri,AINVR_STATS_TEST_MONGO_URI:uri,AINVR_ALARM_TEST_MONGO_URI:uri,AINVR_ALARM_TEST_MONGO:'1'}});
child.on('exit',code=>{process.exitCode=code??1});
