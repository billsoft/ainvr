// Copyright AINVR. Application credentials are separate from root credentials.
const fs = require('fs');
const appDb = db.getSiblingDB('ainvr_snapshots');
appDb.createUser({
  user: 'ainvr_ai',
  pwd: fs.readFileSync('/run/secrets/mongo_app_password', 'utf8').trim(),
  roles: [{ role: 'readWrite', db: 'ainvr_snapshots' }],
});
