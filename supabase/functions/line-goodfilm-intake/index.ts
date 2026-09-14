import { createHandler } from './handler.mjs';

const url = Deno.env.get('SUPABASE_URL')!;
const secrets = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const key = secrets.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const databaseHeaders = {
  apikey: key,
  ...(key?.startsWith('eyJ') ? {Authorization:`Bearer ${key}`} : {}),
  'Content-Type':'application/json',
};
let verifiedBot: {token:string;id:string;expires:number} | null = null;

async function resolveDestination() {
  const token = Deno.env.get('LINE_GOODFILM_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('LINE token missing');
  if (verifiedBot?.token === token && verifiedBot.expires > Date.now()) return verifiedBot.id;
  const response = await fetch('https://api.line.me/v2/bot/info', {
    headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('LINE token invalid');
  const bot = await response.json();
  if (bot.basicId !== '@095jvuls' || !/^U[0-9a-f]{32}$/.test(bot.userId || '')) throw new Error('Wrong LINE account');
  verifiedBot = {token,id:bot.userId,expires:Date.now()+300000};
  return bot.userId;
}

Deno.serve(createHandler({
  getEnv: (name: string) => Deno.env.get(name),
  resolveDestination,
  persist: async (account: string, events: unknown[]) => {
    const response = await fetch(`${url}/rest/v1/rpc/receive_line_intake`, {
      method:'POST',headers:databaseHeaders,body:JSON.stringify({p_account:account,p_events:events}),signal:AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Persistence failed');
  },
  background: (promise: Promise<void>) => EdgeRuntime.waitUntil(promise),
  enrich: async (account: string, users: string[]) => {
    const token = Deno.env.get('LINE_GOODFILM_CHANNEL_ACCESS_TOKEN');
    if (!token) return;
    // Bound concurrency and refresh the name when a person sends a new message.
    for (let offset=0;offset<users.length;offset+=5) {
      await Promise.all(users.slice(offset,offset+5).map(async user => {
        try {
          const response = await fetch(`https://api.line.me/v2/bot/profile/${user}`,{
            headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2500),
          });
          if (!response.ok) return;
          const profile = await response.json();
          if (typeof profile.displayName !== 'string' || !profile.displayName.trim()) return;
          await fetch(`${url}/rest/v1/line_intake_contacts?account_key=eq.${encodeURIComponent(account)}&line_user_id=eq.${user}`,{
            method:'PATCH',headers:databaseHeaders,body:JSON.stringify({display_name:profile.displayName.slice(0,200)}),signal:AbortSignal.timeout(5000),
          });
        } catch { /* Metadata is retained even when a profile is unavailable. */ }
      }));
    }
  },
}));
