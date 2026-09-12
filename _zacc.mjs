import admin from "firebase-admin";import {readFileSync} from "node:fs";
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8")))});
const d=await admin.firestore().doc("workspaces/team/accounts/ziad-cash").get();
console.log(JSON.stringify(d.data(),null,1));process.exit(0);
