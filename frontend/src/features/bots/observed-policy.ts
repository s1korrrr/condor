import type {BotsPageResponse} from '@/lib/api';
import {expireNativeBotPage} from '@/lib/bot-monitoring';
import {object,numeric,type BotPairPosition} from './position-view';

/** MQTT policy is a separate observation; never use it to manufacture inventory or trailing prices. */
export function currentControllerPolicy(page:BotsPageResponse|undefined,bot:string,row:BotPairPosition,now:number) {
  const current=expireNativeBotPage(page,true,now);
  const owner=current?.bots.find(item=>item.bot_name===bot && item.controller_count_current===true);
  const matches=current?.controllers.filter(item=>item.bot_name===bot && item.trading_pair===row.pair) ?? [];
  if(!owner || !row.uniquePair || matches.length!==1 || (row.controllerId && row.controllerId!==matches[0].controller_id)) return null;
  const controller=matches[0], info=object(controller.custom_info), trail=object(info.trailing_policy), operator=object(info.operator);
  const fields:[string,string][]=[];
  if(typeof trail.policy==='string' && trail.policy) fields.push(['Policy',trail.policy.replaceAll('_',' ')]);
  for(const [key,title] of [['anchor_activation_pct','Anchor activation'],['anchor_delta_pct','Anchor trail distance'],['selected_activation_pct','Selected activation'],['selected_delta_pct','Selected trail distance'],['initial_locked_profit_pct','Initial locked profit']]) {
    if(numeric(trail[key])!==null) fields.push([title,`${(numeric(trail[key])!*100).toLocaleString(undefined,{maximumFractionDigits:6})}%`]);
  }
  if(typeof operator.entry_paused==='boolean') fields.push(['New entries',operator.entry_paused?'Paused':'Not paused']);
  for(const [key,title] of [['reason','Operator reason'],['scope','Operator scope']]) if(typeof operator[key]==='string' && operator[key]) fields.push([title,String(operator[key]).replaceAll('_',' ')]);
  return fields.length ? {controllerId:controller.controller_id,receivedAt:owner.performance_received_at!,fields} : null;
}
