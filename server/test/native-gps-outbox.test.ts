import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeNativeOutbox,nativeLocationReplaySql} from '../../mobile/src/nativeOutboxSchema.js';

test('native outbox upgrade and restart preserve even very old pending points',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE TABLE outbox(key TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
    INSERT INTO outbox VALUES('old','location','{}',1,0); INSERT INTO outbox VALUES('work','report','{}',2,0);`);
  const adapter={execSync:(sql:string)=>db.exec(sql),getAllSync:<T>(sql:string)=>db.prepare(sql).all() as T[]};
  initializeNativeOutbox(adapter);initializeNativeOutbox(adapter);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get()?.n,2);
  assert.equal(db.prepare("SELECT rejected FROM outbox WHERE key='old'").get()?.rejected,0);
  db.exec("UPDATE outbox SET rejected=1,attempts=2 WHERE key='old'; INSERT INTO outbox VALUES('fresh','location','{}',3,0,0); INSERT INTO outbox VALUES('untried','location','{}',4,1,1)");
  const automatic=db.prepare(nativeLocationReplaySql(false)).all(200);assert.deepEqual(automatic.map(row=>row.key),['fresh']);
  const manual=db.prepare(nativeLocationReplaySql(true)).all(200);assert.deepEqual(manual.map(row=>row.key),['fresh','untried','old']);
 } finally { db.close(); }
});
