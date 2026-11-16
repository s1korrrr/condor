const coins = (realized, unrealized) => Object.fromEntries(['BNB','BTC','ETH','SOL','XRP'].map(coin => [coin, {realized, unrealized}]));

export const liveMoneyRows = [
  {bot:'v5', at_ms:1794669621197, snapshot_at_ms:1794669621197, equity:'199197.63587918115820', initial_funding:'200000', external_flows:'0', realized:null, unrealized:null, fees:'23.11374454259180', unit:'USDC', coins:coins(null,null)},
  {bot:'helm', at_ms:1794824700000, equity:'100.00000000000000000000', realized:null, unrealized:null},
  {bot:'v5', at_ms:1794824700000, snapshot_at_ms:1794824700000, equity:'199057.11379198655820', initial_funding:'200000', external_flows:'0', realized:'114.13966914839932723814', unrealized:'-1057.03000000000000000000', fees:'23.11374454259180', unit:'USDC', coins:coins('1','-1')},
];
