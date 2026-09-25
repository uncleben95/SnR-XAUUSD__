import webpush from "web-push";
import { Redis } from "@upstash/redis";

const hasVapid = Boolean(
  process.env.VAPID_SUBJECT &&
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY
);

if(hasVapid){
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const SUBSCRIPTIONS_KEY="xau_push_subscriptions";
const LEGACY_KEY="xau_push_subscription";

function parseSubscription(value){
  if(!value)return null;
  try{return typeof value==="string"?JSON.parse(value):value}catch{return null}
}
function normalizeSubscription(s){
  if(!s?.endpoint)return null;
  return {
    endpoint:s.endpoint,
    expirationTime:s.expirationTime??null,
    keys:{p256dh:s.keys?.p256dh,auth:s.keys?.auth}
  };
}

export async function saveSubscription(subscription){
  const n=normalizeSubscription(subscription);
  if(!n?.endpoint||!n?.keys?.p256dh||!n?.keys?.auth)throw new Error("Invalid push subscription");
  const value=JSON.stringify(n);
  await redis.sadd(SUBSCRIPTIONS_KEY,value);
  await redis.set(LEGACY_KEY,value);
  return {ok:true,endpoint:n.endpoint};
}

export async function getSubscriptions(){
  let raw=[];
  try{raw=await redis.smembers(SUBSCRIPTIONS_KEY)}catch(e){console.error("Redis subscription read error:",e?.message||e)}
  let subs=(raw||[]).map(parseSubscription).map(normalizeSubscription).filter(s=>s?.endpoint&&s?.keys?.p256dh&&s?.keys?.auth);

  if(!subs.length){
    try{
      const legacy=normalizeSubscription(parseSubscription(await redis.get(LEGACY_KEY)));
      if(legacy?.endpoint&&legacy?.keys?.p256dh&&legacy?.keys?.auth){
        try{await redis.sadd(SUBSCRIPTIONS_KEY,JSON.stringify(legacy))}catch{}
        subs=[legacy];
      }
    }catch(e){console.error("Legacy subscription read error:",e?.message||e)}
  }
  return subs;
}

export async function sendPushToAll(payload){
  if(!hasVapid)throw new Error("VAPID_SUBJECT/VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY belum lengkap");

  const subscriptions=await getSubscriptions();
  if(!subscriptions.length)return {sent:0,removed:0,failed:0,total:0,details:[]};

  let sent=0,removed=0,failed=0;
  const details=[];

  for(const subscription of subscriptions){
    try{
      await webpush.sendNotification(subscription,JSON.stringify({
        title:payload?.title||"XAU/USD Signal",
        body:payload?.body||"",
        icon:payload?.icon||"/icon.png",
        badge:payload?.badge||"/icon.png",
        tag:payload?.tag||"xau-signal",
        data:{url:payload?.url||"/"}
      }));
      sent++;
      details.push({endpoint:subscription.endpoint?.slice(0,80),status:"SENT"});
    }catch(error){
      const statusCode=error?.statusCode;
      if(statusCode===404||statusCode===410){
        try{await redis.srem(SUBSCRIPTIONS_KEY,JSON.stringify(subscription))}catch{}
        removed++;
        details.push({endpoint:subscription.endpoint?.slice(0,80),status:"REMOVED",statusCode});
      }else{
        failed++;
        details.push({endpoint:subscription.endpoint?.slice(0,80),status:"FAILED",statusCode:statusCode||null,error:error?.message||String(error)});
      }
    }
  }
  return {sent,removed,failed,total:subscriptions.length,details};
}

export { redis };
