import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedCheckIn, confirmedCheckOut, confirmedDailyReport, confirmedReport } from '../../mobile/src/actionConfirmation.js';
import type { DailyReportInput, ReportInput, VisitInput } from '../../mobile/src/types.js';
import { replayOutboxActions } from '../../mobile/src/outboxReplay.js';

const report:ReportInput={id:'r',type:'note',title:'تقرير',body:'شرح',customer:'عميل',amount:null,location:null};
const daily:DailyReportInput={version:1,id:'d',engineerName:'مهندس',reportDate:'2026-01-01',leftAt:'',returnedAt:'',circumstances:'',signedName:'مهندس',confirmed:true,location:null,visits:[{customerName:'عميل',governorate:'',district:'',village:'',phone:'',areaFeddan:null,crops:'',recommendations:'',outcome:''}]};
const visit:VisitInput={id:'v',customerId:'c',purpose:'visit',notes:'',location:{lat:31.2,lng:29.9,accuracy:8}};
test('report confirmations reject HTML, incomplete JSON and conflicting data',()=>{
 const saved={id:'r',type:'note',title:'تقرير',body:'شرح',customer:'عميل',amount:null,lat:null,lng:null,accuracy:null};
 assert.equal(confirmedReport(report,{duplicate:false,report:saved}),true);
 for(const response of [null,'<html>',{report:saved},{duplicate:true,report:{...saved,body:'مختلف'}}]) assert.equal(confirmedReport(report,response),false);
 const {location,confirmed,...rest}=daily;
 const row={...rest,lat:null,lng:null,accuracy:null};
 assert.equal(confirmedDailyReport(daily,{report:row,duplicate:false}),true);
 assert.equal(confirmedDailyReport(daily,{report:{...row,visits:[]},duplicate:true}),false);
 assert.equal(confirmedDailyReport(daily,{report:row}),false);
});
test('visit confirmations require the matching start and result',()=>{
 const start={id:'v',customerId:'c',purpose:'visit',inLat:31.2,inLng:29.9,inAccuracy:8};
 assert.equal(confirmedCheckIn(visit,{duplicate:false,visit:start}),true);
 assert.equal(confirmedCheckIn(visit,{duplicate:true,visit:{...start,customerId:'other'}}),false);
 const body={outcome:'تم',notes:'',location:null};
 const finish={id:'v',status:'closed',outcome:'تم',notes:'',outLat:null,outLng:null};
 assert.equal(confirmedCheckOut('v',body,{duplicate:false,visit:finish}),true);
 assert.equal(confirmedCheckOut('v',body,{duplicate:true,visit:{...finish,outcome:'نتيجة مختلفة'}}),false);
 assert.equal(confirmedCheckOut('v',body,null),false);
});
test('unconfirmed report stays in outbox and produces an explicit warning',async()=>{
 const removed:string[]=[],bumped:string[]=[];
 const result=await replayOutboxActions([{key:'r',kind:'report',payload:JSON.stringify(report)}] as any,{remove:async id=>{removed.push(id);},bump:async id=>{bumped.push(id);},reject:async()=>{},unreject:async()=>{}},{checkIn:async()=>{},checkOut:async()=>{},dailyReport:async()=>{},createOrder:async()=>{},report:async()=>{throw Object.assign(new Error('unknown response'),{status:503,code:'ACTION_CONFIRMATION_UNCERTAIN'});}});
 assert.deepEqual(removed,[]);assert.deepEqual(bumped,['r']);assert.match(result.notice!,/ما زالت على الهاتف/);
});
