(() => {
const C = window.APP_CONFIG;
const $ = (id)=>document.getElementById(id);

const ERC20_ABI = [
"function balanceOf(address) view returns(uint256)",
"function approve(address,uint256)",
"function allowance(address,address) view returns(uint256)",
"function decimals() view returns(uint8)"
];

const STAKE_ABI = [
"function stake(uint256)",
"function withdraw(uint256)",
"function positionsCount(address) view returns(uint256)",
"function getPosition(address,uint256) view returns(uint256,uint256,uint256,bool)",
"function accruedReward(address,uint256) view returns(uint256,uint256)",
"function timeLeft(address,uint256) view returns(uint256)"
];

let provider, signer, user;
let staking, token;
let decimals = 18;
let timer;

function fmt(n){ return Number(n).toLocaleString(); }

async function connect(){
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts",[]);
  signer = await provider.getSigner();
  user = await signer.getAddress();
  $("wallet").textContent = user;

  staking = new ethers.Contract(C.CONTRACT, STAKE_ABI, signer);
  token = new ethers.Contract(C.STC, ERC20_ABI, signer);
  decimals = await token.decimals();

  refresh();
}

async function refresh(){
  const bal = await token.balanceOf(user);
  $("bal").textContent = fmt(ethers.formatUnits(bal,decimals));
  loadPositions();
}

async function loadPositions(){
  const count = await staking.positionsCount(user);
  let html="";
  for(let i=0;i<count;i++){
    const p = await staking.getPosition(user,i);
    const reward = await staking.accruedReward(user,i);
    const left = await staking.timeLeft(user,i);

    const principal = ethers.formatUnits(p[0],decimals);
    const start = new Date(Number(p[1])*1000).toLocaleDateString();
    const unlock = new Date(Number(p[2])*1000).toLocaleDateString();
    const accrued = ethers.formatUnits(reward[0],decimals);
    const withdrawn = p[3];

    html+=`
    <tr>
      <td>${i}</td>
      <td>${fmt(principal)}</td>
      <td>${start}</td>
      <td>${unlock}</td>
      <td id="cd_${i}">-</td>
      <td>${fmt(accrued)}</td>
      <td>${withdrawn ? "Withdrawn":"Active"}</td>
      <td>${!withdrawn && left==0 ? `<button onclick="withdraw(${i})">Withdraw</button>`:"-"}</td>
    </tr>
    `;
  }
  $("posBody").innerHTML=html;
  startCountdown();
}

function startCountdown(){
  if(timer) clearInterval(timer);
  timer=setInterval(async()=>{
    const count = await staking.positionsCount(user);
    for(let i=0;i<count;i++){
      const left = await staking.timeLeft(user,i);
      const el = document.getElementById("cd_"+i);
      if(!el) continue;
      el.textContent = left==0?"Ready":formatTime(left);
    }
  },1000);
}

function formatTime(sec){
  sec=Number(sec);
  const d=Math.floor(sec/86400);
  sec%=86400;
  const h=Math.floor(sec/3600);
  sec%=3600;
  const m=Math.floor(sec/60);
  const s=Math.floor(sec%60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

window.withdraw = async(id)=>{
  const tx = await staking.withdraw(id);
  await tx.wait();
  refresh();
}

$("btnConnect").onclick=connect;

$("btnApprove").onclick=async()=>{
  const amt = ethers.parseUnits($("stakeAmt").value,decimals);
  const tx = await token.approve(C.CONTRACT,amt);
  await tx.wait();
  alert("Approved");
}

$("btnStake").onclick=async()=>{
  const amt = ethers.parseUnits($("stakeAmt").value,decimals);
  const tx = await staking.stake(amt);
  await tx.wait();
  refresh();
}

})();
