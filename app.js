;(() => {
  "use strict";

  const C = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const setText = (id, t) => { const el = $(id); if (el) el.textContent = String(t ?? "-"); };
  const setStatus = (t) => { const el = $("status"); if (el) el.textContent = String(t ?? "-"); };

  const shortAddr = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "-");

  const fmtDate = (sec) => {
    try { return new Date(Number(sec) * 1000).toLocaleString(); } catch { return "-"; }
  };

  const fmtDur = (sec) => {
    sec = Math.max(0, Number(sec) || 0);
    const d = Math.floor(sec / 86400); sec -= d * 86400;
    const h = Math.floor(sec / 3600);  sec -= h * 3600;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec - m * 60);
    const pad = (n) => String(n).padStart(2, "0");
    return (d > 0 ? `${d}d ` : "") + `${pad(h)}:${pad(m)}:${pad(s)}`;
  };

  // -------- ABIs --------
  const ERC20_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)",
    "function decimals() view returns(uint8)",
    "function symbol() view returns(string)"
  ];

  // จาก ABI ที่คุณส่งของสัญญา 0xe168...
  const STAKING_ABI = [
    "function STC() view returns(address)",
    "function LOCK_SECONDS() view returns(uint256)",
    "function rewardBps() view returns(uint256)",
    "function minStake() view returns(uint256)",

    "function positionsCount(address) view returns(uint256)",
    "function getPosition(address,uint256) view returns(uint256 principal,uint256 startTime,uint256 unlockAt,bool withdrawn)",
    "function matured(address,uint256) view returns(bool)",
    "function accruedReward(address,uint256) view returns(uint256 accrued,uint256 elapsedDays)",

    "function contractSTCBalance() view returns(uint256)",
    "function stake(uint256 amount) external",
    "function withdraw(uint256 posId) external"
  ];

  // -------- State --------
  let provider = null;
  let signer = null;
  let user = null;

  let staking = null;
  let stc = null;

  let stcDec = 18;
  let lastSTCBal = 0n;

  // countdown loop (มือถือบางตัว pause/clear interval ได้ง่าย)
  // เราจะใช้ "unlockAt - now" ทุกครั้ง ไม่ลดทีละ 1
  let countdownTimer = null;
  const unlockCache = new Map(); // posId -> unlockAt(sec)

  // -------- Chain helpers --------
  async function ensureBSC() {
    if (!window.ethereum) throw new Error("ไม่พบกระเป๋า (Bitget/MetaMask)");
    const want = (C.CHAIN_ID_HEX || "0x38").toLowerCase();

    try {
      const got = String(await window.ethereum.request({ method: "eth_chainId" })).toLowerCase();
      if (got === want) return true;
    } catch {}

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: C.CHAIN_ID_HEX || "0x38" }],
      });
      return true;
    } catch (e) {
      const msg = String(e?.message || e);
      if (e?.code === 4902 || msg.includes("4902")) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: C.CHAIN_ID_HEX || "0x38",
            chainName: C.CHAIN_NAME || "BSC Mainnet",
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            rpcUrls: [C.RPC_URL || "https://bsc-dataseed.binance.org/"],
            blockExplorerUrls: [C.EXPLORER || "https://bscscan.com"],
          }],
        });
        return true;
      }
      throw new Error("กรุณาสลับเครือข่ายเป็น BSC (56) ก่อนทำรายการ");
    }
  }

  function updateLinks() {
    const explorer = C.EXPLORER || "https://bscscan.com";
    setText("contract", C.CONTRACT);
    const lc = $("linkContract"); if (lc) lc.href = `${explorer}/address/${C.CONTRACT}`;
    const lw = $("linkWallet");   if (lw && user) lw.href = `${explorer}/address/${user}`;
  }

  // -------- Connect --------
  async function connect() {
    try {
      if (!window.ethereum) throw new Error("ไม่พบกระเป๋า (Bitget/MetaMask)");

      provider = new ethers.BrowserProvider(window.ethereum);

      // ขอ account ก่อน (สำคัญบนมือถือ)
      await provider.send("eth_requestAccounts", []);
      await ensureBSC();

      signer = await provider.getSigner();
      user = await signer.getAddress();

      staking = new ethers.Contract(C.CONTRACT, STAKING_ABI, signer);
      stc = new ethers.Contract(C.STC, ERC20_ABI, signer);

      try { stcDec = Number(await stc.decimals()); } catch { stcDec = 18; }

      setText("wallet", shortAddr(user));
      updateLinks();

      $("btnRefresh").disabled = false;
      $("btnApprove").disabled = false;
      $("btnStake").disabled = false;

      setStatus("✅ เชื่อมต่อสำเร็จ (BSC)");
      await refreshAll();

      // events ช่วยมือถือ: ถ้าสลับ chain/account ให้ refresh เอง
      if (window.ethereum?.on) {
        window.ethereum.removeListener?.("accountsChanged", onAccountsChanged);
        window.ethereum.removeListener?.("chainChanged", onChainChanged);
        window.ethereum.on("accountsChanged", onAccountsChanged);
        window.ethereum.on("chainChanged", onChainChanged);
      }
    } catch (e) {
      console.error(e);
      setStatus(`❌ ${e?.shortMessage || e?.message || e}`);
    }
  }

  async function onAccountsChanged(accs) {
    try {
      if (!accs || !accs[0]) return;
      user = ethers.getAddress(accs[0]);
      setText("wallet", shortAddr(user));
      updateLinks();
      await refreshAll();
    } catch {}
  }

  async function onChainChanged() {
    // บาง wallet reload ตัวเอง บางตัวไม่ reload เราจัดการให้
    try {
      await ensureBSC();
      await refreshAll();
    } catch {}
  }

  // -------- Refresh --------
  async function refreshBalances() {
    if (!user) return;

    const [bal, alw] = await Promise.all([
      stc.balanceOf(user),
      stc.allowance(user, C.CONTRACT),
    ]);

    lastSTCBal = bal;

    setText("balSTC", ethers.formatUnits(bal, stcDec));
    setText("allowSTC", ethers.formatUnits(alw, stcDec));

    // โชว์ MAX ในช่อง (แต่ไม่ให้แก้)
    const inp = $("inStake");
    if (inp) inp.value = ethers.formatUnits(bal, stcDec);
  }

  async function refreshParams() {
    try {
      const [lockS, bps, minS, cBal] = await Promise.all([
        staking.LOCK_SECONDS(),
        staking.rewardBps(),
        staking.minStake(),
        staking.contractSTCBalance(),
      ]);

      setText("pLock", lockS.toString());
      setText("pBps", bps.toString());
      setText("pMin", minS.toString());
      setText("cSTC", ethers.formatUnits(cBal, stcDec));
    } catch (e) {
      // ไม่ให้หน้าแตก
      console.warn("refreshParams fail", e);
    }
  }

  async function refreshPositions() {
    if (!user) return;

    const count = Number(await staking.positionsCount(user));
    setText("posCount", count);

    const tbody = $("posTbody");
    tbody.innerHTML = "";

    unlockCache.clear();

    if (count === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted">ยังไม่มี position</td></tr>`;
      stopCountdown();
      return;
    }

    // ดึงพร้อมกันให้ไว
    const ids = Array.from({ length: count }, (_, i) => i);

    const posAll = await Promise.all(ids.map(i => staking.getPosition(user, i)));
    const maturedAll = await Promise.all(ids.map(i => staking.matured(user, i)));
    const accruedAll = await Promise.all(ids.map(i => staking.accruedReward(user, i)));

    for (let i = 0; i < count; i++) {
      const posId = ids[i];
      const p = posAll[i];
      const matured = maturedAll[i];
      const ar = accruedAll[i];

      const principal = p.principal;
      const startTime = p.startTime;
      const unlockAt = p.unlockAt;
      const withdrawn = p.withdrawn;

      unlockCache.set(String(posId), Number(unlockAt));

      const accrued = ar.accrued;

      const statusText = withdrawn ? "WITHDRAWN" : (matured ? "MATURED" : "LOCKED");
      const statusClass = withdrawn ? "no" : (matured ? "ok" : "warn");

      const canWithdraw = (!!matured && !withdrawn);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${posId}</td>
        <td class="mono">${ethers.formatUnits(principal, stcDec)}</td>
        <td class="mono">${fmtDate(startTime)}</td>
        <td class="mono">${fmtDate(unlockAt)}</td>
        <td class="mono" id="cd_${posId}">-</td>
        <td class="mono">${ethers.formatUnits(accrued, stcDec)}</td>
        <td class="${statusClass}" id="st_${posId}">${statusText}</td>
        <td>
          <button class="smallbtn" data-posid="${posId}" ${canWithdraw ? "" : "disabled"}>
            Withdraw
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll(`button[data-posid]`).forEach(btn => {
      btn.addEventListener("click", async () => {
        const posId = Number(btn.dataset.posid);
        await withdraw(posId);
      });
    });

    startCountdown();
  }

  function stopCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function startCountdown() {
    stopCountdown();

    // ใช้ now-based ทุกครั้ง (มือถือไม่เดินก็ยัง “ถูก” เมื่อกลับมา)
    countdownTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);

      for (const [posId, unlockAt] of unlockCache.entries()) {
        const cd = document.getElementById(`cd_${posId}`);
        if (!cd) continue;

        const left = unlockAt - now;
        cd.textContent = left <= 0 ? "ครบแล้ว ✅" : fmtDur(left);

        const st = document.getElementById(`st_${posId}`);
        if (st && left <= 0 && st.textContent === "LOCKED") {
          st.textContent = "MATURED";
          st.className = "ok";
          const btn = document.querySelector(`button[data-posid="${posId}"]`);
          if (btn) btn.disabled = false;
        }
      }
    }, 1000);

    // กัน iOS/Bitget ที่ pause timer: พอกลับมา foreground ให้ refresh
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        // รีคำนวณทันที
        try {
          const now = Math.floor(Date.now() / 1000);
          for (const [posId, unlockAt] of unlockCache.entries()) {
            const cd = document.getElementById(`cd_${posId}`);
            if (!cd) continue;
            const left = unlockAt - now;
            cd.textContent = left <= 0 ? "ครบแล้ว ✅" : fmtDur(left);
          }
        } catch {}
      }
    }, { passive: true });
  }

  async function refreshAll() {
    try {
      if (!user) return;
      $("btnRefresh").disabled = true;

      await Promise.all([
        refreshBalances(),
        refreshParams(),
      ]);
      await refreshPositions();

      $("btnRefresh").disabled = false;
      setStatus("✅ อัปเดตแล้ว");
    } catch (e) {
      console.error(e);
      $("btnRefresh").disabled = false;
      setStatus(`❌ ${e?.shortMessage || e?.message || e}`);
    }
  }

  // -------- Actions --------
  async function approveSTC() {
    try {
      if (!user) throw new Error("กรุณาเชื่อมต่อกระเป๋าก่อน");
      await ensureBSC();

      $("btnApprove").disabled = true;
      setStatus("⏳ กำลัง Approve STC...");

      const tx = await stc.approve(C.CONTRACT, ethers.MaxUint256);
      setStatus("⏳ ส่งธุรกรรมแล้ว รอยืนยันในกระเป๋า...");
      await tx.wait();

      setStatus("✅ Approve สำเร็จ");
      await refreshBalances();
      $("btnApprove").disabled = false;
    } catch (e) {
      console.error(e);
      $("btnApprove").disabled = false;
      setStatus(`❌ ${e?.shortMessage || e?.message || e}`);
    }
  }

  async function stakeMax() {
    try {
      if (!user) throw new Error("กรุณาเชื่อมต่อกระเป๋าก่อน");
      await ensureBSC();

      // ✅ บังคับ MAX = stake ทั้งหมดในกระเป๋า
      const amt = lastSTCBal;

      if (amt <= 0n) throw new Error("STC ในกระเป๋าเป็น 0");
      // กันเคส stake แล้วค้างค่า old
      const minStake = await staking.minStake();
      if (amt < minStake) throw new Error(`ยอดน้อยกว่า minStake (${ethers.formatUnits(minStake, stcDec)} STC)`);

      $("btnStake").disabled = true;
      setStatus(`⏳ กำลัง Stake MAX: ${ethers.formatUnits(amt, stcDec)} STC ...`);

      // บาง wallet มือถือ estimateGas แกว่ง -> ใส่ gasLimit buffer
      let tx;
      try {
        const est = await staking.stake.estimateGas(amt);
        const gasLimit = (est * 130n) / 100n; // +30%
        tx = await staking.stake(amt, { gasLimit });
      } catch {
        tx = await staking.stake(amt);
      }

      setStatus("⏳ ส่งธุรกรรมแล้ว รอยืนยัน...");
      await tx.wait();

      setStatus("✅ Stake สำเร็จ");
      await refreshAll();
      $("btnStake").disabled = false;
    } catch (e) {
      console.error(e);
      $("btnStake").disabled = false;
      setStatus(`❌ ${e?.shortMessage || e?.message || e}`);
    }
  }

  async function withdraw(posId) {
    try {
      if (!user) throw new Error("กรุณาเชื่อมต่อกระเป๋าก่อน");
      await ensureBSC();

      const ok = confirm(`ยืนยันถอน posId #${posId} ?\n(จะจ่าย STC: ต้น + ดอก)`);
      if (!ok) return;

      setStatus(`⏳ กำลังถอน posId #${posId}...`);

      let tx;
      try {
        const est = await staking.withdraw.estimateGas(posId);
        const gasLimit = (est * 130n) / 100n;
        tx = await staking.withdraw(posId, { gasLimit });
      } catch {
        tx = await staking.withdraw(posId);
      }

      setStatus("⏳ ส่งธุรกรรมแล้ว รอยืนยัน...");
      await tx.wait();

      setStatus(`✅ ถอน posId #${posId} สำเร็จ`);
      await refreshAll();
    } catch (e) {
      console.error(e);
      setStatus(`❌ ${e?.shortMessage || e?.message || e}`);
    }
  }

  // -------- Bind UI --------
  function bind() {
    $("btnConnect")?.addEventListener("click", connect);
    $("btnRefresh")?.addEventListener("click", refreshAll);
    $("btnApprove")?.addEventListener("click", approveSTC);
    $("btnStake")?.addEventListener("click", stakeMax);
  }

  bind();
  updateLinks();
})();
