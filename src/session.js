import fs from 'node:fs/promises';
import path from 'node:path';
const file=path.resolve('data/session-state.json');
const state={configured:false,status:'not_configured',updatedAt:null,lastCheck:null};
export async function loadSessionState(){try{Object.assign(state,JSON.parse(await fs.readFile(file,'utf8')))}catch{}return {...state};}
export async function saveSessionMetadata(meta){await fs.mkdir(path.dirname(file),{recursive:true});Object.assign(state,meta,{updatedAt:new Date().toISOString()});await fs.writeFile(file,JSON.stringify(state,null,2));return {...state};}
export const getSessionState=()=>({...state});
export async function registerSessionSubmission(){return saveSessionMetadata({configured:true,status:'submitted',lastCheck:new Date().toISOString()});}
