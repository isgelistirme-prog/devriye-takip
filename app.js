/**
 * KARAKUŞ PLATFORM - FRONTEND ENGINE (Profesyonel Mesai Yönetimi)
 */
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyXnLMCDiqyPHkM36MiLKo43SWCEeJTeMoKr_ZxHxA3SI_i71JyAuQciTDCpIr6DU9mUQ/exec',
  CLIENT_ID: '653251016114-4340l82dqeldg25umf3749gr9b4aj8gn.apps.googleusercontent.com'
};

const CURRENT_SHIFT_KEY = 'karakus_current_shift';
const SHIFT_HISTORY_KEY = 'karakus_shift_history';
const OFFLINE_SHIFT_KEY = 'karakus_offline_shifts';

let currentUser = JSON.parse(localStorage.getItem('karakus_user'));
let html5QrCode = null;
let camState = 'idle';
let timerInterval = null;

window.onload = () => {
  initNetworkListeners();
  if (currentUser && currentUser.sessionToken) {
    onLoginSuccess();
  } else {
    initializeGoogleLogin();
  }
  requestNotificationPermission();
};

// ================= UI & TOAST =================
function showToast(message, type = 'success') {
  if (navigator.vibrate) navigator.vibrate(type === 'error' ? [100,50,100] : [50]);
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success'?'✅':type==='error'?'❌':'⚠️'}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.animation = "fadeOut 0.3s forwards"; setTimeout(() => toast.remove(), 300); }, 3000);
}

function showModal(title, message, type = 'info', cb = null) {
  const modal = document.getElementById('alertModal');
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalMessage').textContent = message;
  
  const iconEl = document.getElementById('modalIcon');
  if (type === 'critical') {
    iconEl.innerHTML = '<i class="fas fa-circle-exclamation" style="color: #ef4444;"></i>';
  } else if (type === 'success') {
    iconEl.innerHTML = '<i class="fas fa-circle-check" style="color: #22c55e;"></i>';
  } else {
    iconEl.innerHTML = '<i class="fas fa-triangle-exclamation" style="color: #f59e0b;"></i>';
  }
  
  modal.classList.remove('hidden');
  document.getElementById('modalBtn').onclick = () => {
    modal.classList.add('hidden');
    if (cb) cb();
  };
}

// ================= AUTH =================
function initializeGoogleLogin() {
  google.accounts.id.initialize({
    client_id: CONFIG.CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false,
    prompt: 'select_account'
  });
  google.accounts.id.renderButton(document.getElementById('g_id_signin'), { theme: 'filled_blue', size: 'large', width: 280 });
}

async function handleCredentialResponse(response) {
  document.querySelector('.subtitle').textContent = "Oturum açılıyor...";
  try {
    const res = await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST', body: JSON.stringify({ action: 'verifyUser', token: response.credential })
    });
    const data = await res.json();
    if (data.status === 'active') {
      currentUser = { email: data.email, name: data.name, sessionToken: data.sessionToken };
      localStorage.setItem('karakus_user', JSON.stringify(currentUser));
      onLoginSuccess();
    } else {
      showModal("Erişim Reddedildi", data.message, "critical");
    }
  } catch (error) {
    showToast("Sunucuya ulaşılamadı. Lütfen bağlantınızı kontrol edin.", "error");
  }
}

function onLoginSuccess() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('mainScreen').classList.remove('hidden');
  document.getElementById('displayName').textContent = currentUser.name;
  document.getElementById('userInitial').textContent = currentUser.name.charAt(0).toUpperCase();
  syncOfflineData();
  initScanner();
  updateAttendanceUI();
  document.getElementById('reportBtn').addEventListener('click', showReport);
}

// ================= OFFLINE & SYNC =================
function initNetworkListeners() {
  window.addEventListener('online', () => {
    document.getElementById('networkStatus').innerHTML = '🟢 Çevrimiçi';
    document.getElementById('networkStatus').style.color = '#2e7d32';
    syncOfflineData();
  });
  window.addEventListener('offline', () => {
    document.getElementById('networkStatus').innerHTML = '🔴 Çevrimdışı (Kayıtlar saklanacak)';
    document.getElementById('networkStatus').style.color = '#c62828';
  });
}

async function syncOfflineData() {
  // Devriye senkronizasyonu (korundu)
  const offlineScans = JSON.parse(localStorage.getItem('karakus_offline_scans') || '[]');
  if (offlineScans.length > 0 && navigator.onLine) {
    try {
      await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'syncOffline', scans: offlineScans }) });
      localStorage.removeItem('karakus_offline_scans');
      showToast("Devriye kayıtları sunucuya aktarıldı.");
    } catch (e) { console.error("Sync hatası", e); }
  }

  // Mesai senkronizasyonu (Yeni)
  const offlineShifts = JSON.parse(localStorage.getItem(OFFLINE_SHIFT_KEY) || '[]');
  if (offlineShifts.length > 0 && navigator.onLine) {
    showToast(`${offlineShifts.length} mesai kaydı senkronize ediliyor...`, 'warning');
    try {
      await fetch(CONFIG.SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ action: 'syncAttendance', records: offlineShifts })
      });
      localStorage.removeItem(OFFLINE_SHIFT_KEY);
      showToast("Mesai kayıtları sunucuya aktarıldı.");
    } catch (e) { console.error('Mesai senkronizasyon hatası', e); }
  }
}

// ================= SCANNER (Aynı) =================
async function initScanner() {
  if (camState === 'starting' || camState === 'scanning') return;
  camState = 'starting';
  document.getElementById('scanResult').innerHTML = "⏳ Kamera başlatılıyor...";
  try {
    if (html5QrCode) {
      await html5QrCode.stop().catch(()=>{});
      html5QrCode.clear();
    }
    html5QrCode = new Html5Qrcode("reader");
    await html5QrCode.start({ facingMode: { exact: "environment" } }, { fps: 10, qrbox: { width: 250, height: 250 } }, onScanSuccess)
      .catch(() => html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 250 } }, onScanSuccess));
    camState = 'scanning';
    document.getElementById('scanResult').innerHTML = "🟢 Kamera aktif, barkod okutun.";
  } catch (err) {
    camState = 'idle';
    document.getElementById('scanResult').innerHTML = "❌ Kamera hatası. Tekrar deneyin.";
  }
}

function stopScanner() {
  if (html5QrCode && camState === 'scanning') {
    html5QrCode.stop().then(() => { camState = 'idle'; }).catch(()=>{});
  }
}

document.getElementById('stopScanBtn').addEventListener('click', () => {
  stopScanner(); setTimeout(initScanner, 500);
});

// ================= QR OKUMA ve YÖNLENDİRME =================
function onScanSuccess(decodedText) {
  if (camState === 'processing') return;
  if (navigator.vibrate) navigator.vibrate(100);
  playBeep();

  const cleanText = decodedText.trim().toUpperCase().replace(/İ/g, 'I');
  console.log('QR okundu:', cleanText);
  
  if (cleanText === 'MESAI') {
    camState = 'processing';
    handleAttendance(decodedText);
    return;
  }

  // Normal devriye
  camState = 'processing';
  document.getElementById('scanResult').innerHTML = "📍 Konum doğrulanıyor...";
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => processScanPayload(decodedText, pos.coords.latitude, pos.coords.longitude),
      err => processScanPayload(decodedText, null, null),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  } else {
    processScanPayload(decodedText, null, null);
  }
}

function playBeep() {
  try {
    const audio = new Audio('data:audio/wav;base64,UklGRlAAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAACAgICAf39/f39/f3+AgICAf39/f39/f3+AgICAf39/f38=');
    audio.volume = 0.3;
    audio.play().catch(() => {});
  } catch(e) {}
}

// ================= DEVRİYE KAYDI (Aynı) =================
async function processScanPayload(qrText, lat, lng) {
  const payload = {
    action: 'saveScan', qrText: qrText, lat: lat, lng: lng,
    email: currentUser.email, name: currentUser.name, timestamp: new Date().toISOString()
  };

  if (!navigator.onLine) {
    const offlineScans = JSON.parse(localStorage.getItem('karakus_offline_scans') || '[]');
    offlineScans.push(payload);
    localStorage.setItem('karakus_offline_scans', JSON.stringify(offlineScans));
    showToast(`${qrText} çevrimdışı kaydedildi.`);
    resumeScanner();
    return;
  }

  document.getElementById('scanResult').innerHTML = "⏳ Veri sunucuya iletiliyor...";
  try {
    const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(`${qrText} başarıyla kaydedildi.`);
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    showToast("Ağ hatası. Çevrimdışı kaydedilecek.", "warning");
    const offlineScans = JSON.parse(localStorage.getItem('karakus_offline_scans') || '[]');
    offlineScans.push(payload);
    localStorage.setItem('karakus_offline_scans', JSON.stringify(offlineScans));
  }
  resumeScanner();
}

function resumeScanner() {
  document.getElementById('scanResult').innerHTML = "🟢 Sonraki nokta bekleniyor...";
  setTimeout(() => { camState = 'scanning'; }, 2000);
}

// ================= PROFESYONEL MESAİ YÖNETİMİ =================
function generateShiftId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

async function handleAttendance(qrText) {
  const cleanText = qrText.trim().toUpperCase().replace(/İ/g, 'I');
  if (cleanText !== 'MESAI') return;

  // Uyarı kontrolü
  const warning = await fetchAdminWarnings();
  if (warning) {
    showModal('Yönetici Uyarısı', warning, 'warning', () => processAttendance());
    return;
  }
  processAttendance();
}

function processAttendance() {
  const currentShift = JSON.parse(localStorage.getItem(CURRENT_SHIFT_KEY));
  const todayStr = new Date().toDateString();

  // 1. Dünkü yarım kalan mesaiyi sıfırla
  if (currentShift && new Date(currentShift.startTime).toDateString() !== todayStr && currentShift.status === 'started') {
    localStorage.removeItem(CURRENT_SHIFT_KEY);
    // Bu durumda yeni mesai başlatmaya zorla
    startNewShift();
    return;
  }

  // 2. Eğer aktif mesai yoksa başlat
  if (!currentShift) {
    startNewShift();
    return;
  }

  // 3. Eğer mesai "started" ise bitir
  if (currentShift.status === 'started') {
    const start = new Date(currentShift.startTime);
    const elapsedMin = (Date.now() - start.getTime()) / 1000 / 60;

    // Minimum 1 saat kontrolü
    if (elapsedMin < 1) {
      showModal('Mesai Bitişi', `Henüz 1 saat dolmadı (${Math.floor(elapsedMin)} dk). Mesai bitirmek için en az 1 saat çalışmalısınız.`, 'warning');
      resumeScannerAfterAttendance();
      return;
    }

    // Mesaiyi sonlandır
    currentShift.status = 'ended';
    currentShift.endTime = new Date().toISOString();
    currentShift.durationSeconds = (Date.now() - start.getTime()) / 1000;
    
    // Yerel geçmişe ekle
    addToHistory(currentShift);
    // Sunucuya gönder (çevrimdışıysa kuyruğa al)
    syncShiftToServer(currentShift);
    
    localStorage.removeItem(CURRENT_SHIFT_KEY);
    updateAttendanceUI();

    const durationStr = formatDuration(currentShift.durationSeconds);
    showToast(`✅ Mesai tamamlandı! (${durationStr})`, 'success');
    sendNotification('Mesai Bitti', `Bugünkü çalışmanız ${durationStr} sürdü.`);
    resumeScannerAfterAttendance();
    return;
  }

  // 4. Eğer mesai "ended" (daha önce bitmiş) ise yeni vardiya başlat
  if (currentShift.status === 'ended') {
    showModal('Yeni Vardiya', 'Bir önceki mesai kaydınız tamamlandı. Yeni bir mesai (vardiya) başlatmak ister misiniz?', 'info', () => {
      localStorage.removeItem(CURRENT_SHIFT_KEY);
      startNewShift();
      resumeScannerAfterAttendance();
    });
  }
}

function startNewShift() {
  const newShift = {
    id: generateShiftId(),
    startTime: new Date().toISOString(),
    endTime: null,
    durationSeconds: 0,
    status: 'started',
    email: currentUser.email,
    name: currentUser.name
  };
  localStorage.setItem(CURRENT_SHIFT_KEY, JSON.stringify(newShift));
  updateAttendanceUI();
  showToast('✅ Mesai başlatıldı! Görev başlangıcı.', 'success');
  sendNotification('Mesai Başladı', 'Çalışma süreniz başlatıldı.');
}

function resumeScannerAfterAttendance() {
  setTimeout(() => {
    camState = 'scanning';
    document.getElementById('scanResult').innerHTML = "🟢 Kamera aktif, barkod okutun.";
  }, 1500);
}

// ================= MESAİ GEÇMİŞİ VE SENKRONİZASYON =================
function addToHistory(shift) {
  const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
  history.push({
    id: shift.id,
    startTime: shift.startTime,
    endTime: shift.endTime,
    durationSeconds: shift.durationSeconds,
    name: shift.name,
    email: shift.email,
    date: new Date(shift.startTime).toLocaleDateString('tr-TR')
  });
  localStorage.setItem(SHIFT_HISTORY_KEY, JSON.stringify(history));
}

async function syncShiftToServer(shift) {
  const payload = {
    action: 'clockOut',
    email: currentUser.email,
    name: currentUser.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    durationSeconds: shift.durationSeconds
  };

  if (!navigator.onLine) {
    const offline = JSON.parse(localStorage.getItem(OFFLINE_SHIFT_KEY) || '[]');
    offline.push(payload);
    localStorage.setItem(OFFLINE_SHIFT_KEY, JSON.stringify(offline));
    return;
  }

  try {
    await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  } catch(e) {
    console.warn('Mesai senkronizasyon hatası', e);
    const offline = JSON.parse(localStorage.getItem(OFFLINE_SHIFT_KEY) || '[]');
    offline.push(payload);
    localStorage.setItem(OFFLINE_SHIFT_KEY, JSON.stringify(offline));
  }
}

// ================= MESAİ UI GÜNCELLEME =================
function updateAttendanceUI() {
  const shift = JSON.parse(localStorage.getItem(CURRENT_SHIFT_KEY));
  const statusEl = document.getElementById('attStatus');
  const timerEl = document.getElementById('attTimer');
  const iconEl = document.getElementById('attIcon');
  
  if (timerInterval) clearInterval(timerInterval);

  if (!shift) {
    // Tarihteki son bitmiş vardiyayı göstermek için history'ye bakalım
    const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
    const lastShift = history.length > 0 ? history[history.length - 1] : null;
    if (lastShift && new Date(lastShift.startTime).toDateString() === new Date().toDateString()) {
      statusEl.textContent = `Bugün son mesai: ${formatDuration(lastShift.durationSeconds)}`;
      timerEl.textContent = formatDuration(lastShift.durationSeconds);
      iconEl.innerHTML = '<i class="fas fa-flag-checkered" style="color: #ef4444;"></i>';
    } else {
      statusEl.textContent = 'Bugün mesai başlatılmadı';
      timerEl.textContent = '00:00:00';
      iconEl.innerHTML = '<i class="fas fa-clock"></i>';
    }
    return;
  }

  if (shift.status === 'started') {
    statusEl.textContent = 'Mesai devam ediyor';
    iconEl.innerHTML = '<i class="fas fa-play-circle" style="color: #22c55e;"></i>';
    timerInterval = setInterval(() => {
      const elapsed = (Date.now() - new Date(shift.startTime).getTime()) / 1000;
      timerEl.textContent = formatDuration(elapsed);
    }, 1000);
  } else if (shift.status === 'ended') {
    statusEl.textContent = `Mesai tamamlandı (${formatDuration(shift.durationSeconds)})`;
    timerEl.textContent = formatDuration(shift.durationSeconds);
    iconEl.innerHTML = '<i class="fas fa-flag-checkered" style="color: #ef4444;"></i>';
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ================= RAPOR (Yeni Profesyonel Yapı) =================
async function showReport() {
  const modal = document.getElementById('reportModal');
  const content = document.getElementById('reportContent');
  modal.classList.remove('hidden');

  content.innerHTML = `
    <div style="display:flex; justify-content:center; gap:10px; margin-bottom:20px;">
      <button class="btn btn-primary" onclick="fetchAndDisplayReport('week')" style="width:auto; padding:10px 18px;">📅 Bu Hafta</button>
      <button class="btn btn-primary" onclick="fetchAndDisplayReport('month')" style="width:auto; padding:10px 18px;">📅 Bu Ay</button>
    </div>
    <div style="display:flex; justify-content:center; gap:10px; align-items:center; flex-wrap:wrap;">
      <label style="font-size:14px; font-weight:600;">Özel Aralık:</label>
      <input type="date" id="reportStartDate" style="padding:6px; border:1px solid var(--border); border-radius:8px;">
      <span> - </span>
      <input type="date" id="reportEndDate" style="padding:6px; border:1px solid var(--border); border-radius:8px;">
      <button class="btn btn-primary" onclick="fetchAndDisplayReport('custom')" style="width:auto; padding:6px 14px;">Getir</button>
    </div>
    <div id="reportData" style="margin-top:20px; max-height:400px; overflow-y:auto;">
      <p style="color:#666; text-align:center;">Yukarıdan rapor dönemi seçiniz.</p>
    </div>
  `;

  window.fetchAndDisplayReport = async (type) => {
    const dataDiv = document.getElementById('reportData');
    dataDiv.innerHTML = '<p style="color:#666; text-align:center;">⏳ Veriler yükleniyor...</p>';

    let startDate, endDate = new Date();
    const now = new Date();
    
    if (type === 'week') {
      const day = now.getDay() || 7;
      startDate = new Date(now);
      startDate.setDate(now.getDate() - day + 1);
      startDate.setHours(0,0,0,0);
      endDate = new Date(now);
    } else if (type === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now);
    } else if (type === 'custom') {
      startDate = new Date(document.getElementById('reportStartDate').value);
      endDate = new Date(document.getElementById('reportEndDate').value);
      if (!startDate || !endDate || startDate > endDate) {
        dataDiv.innerHTML = '<p style="color:red;">Lütfen geçerli bir tarih aralığı seçin.</p>';
        return;
      }
      endDate.setHours(23,59,59,999);
    }

    try {
      const res = await fetch(CONFIG.SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({
          action: 'getAttendance',
          email: currentUser.email,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        })
      });
      const data = await res.json();
      
      if (data.status === 'success' && data.records.length > 0) {
        let totalSeconds = 0;
        let html = `<table><thead><tr><th>Tarih</th><th>Başlangıç</th><th>Bitiş</th><th>Süre</th></tr></thead><tbody>`;
        data.records.forEach(item => {
          const start = new Date(item.startTime).toLocaleString('tr-TR');
          const end = item.endTime ? new Date(item.endTime).toLocaleString('tr-TR') : 'Devam Ediyor';
          const dur = formatDuration(item.durationSeconds || 0);
          totalSeconds += item.durationSeconds || 0;
          html += `<tr><td>${new Date(item.startTime).toLocaleDateString('tr-TR')}</td><td>${start}</td><td>${end}</td><td>${dur}</td></tr>`;
        });
        html += `</tbody></table>`;
        html += `<div style="text-align:right; font-size:16px; font-weight:700; margin-top:10px;">Toplam Süre: <span style="color:var(--primary);">${formatDuration(totalSeconds)}</span></div>`;
        dataDiv.innerHTML = html;
      } else {
        dataDiv.innerHTML = '<p class="empty">Bu döneme ait kayıt bulunamadı.</p>';
      }
    } catch (error) {
      dataDiv.innerHTML = '<p style="color:red;">Rapor yüklenirken hata oluştu. Lütfen bağlantınızı kontrol edin.</p>';
    }
  };
}

document.getElementById('reportCloseBtn').addEventListener('click', () => {
  document.getElementById('reportModal').classList.add('hidden');
});

// ================= UYARI FONKSİYONU =================
async function fetchAdminWarnings() {
  try {
    const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'getWarning' }) });
    const data = await res.json();
    if (data.warning) return data.warning;
    return null;
  } catch(e) {
    console.error('Uyarı alınamadı:', e);
    return null;
  }
}

// ================= PUSH BİLDİRİM =================
function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
  Notification.requestPermission();
}

function sendNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: 'logo.png' });
  } catch(e) {}
}

// ================= ÇIKIŞ =================
document.getElementById('logoutBtn').addEventListener('click', () => {
  showModal("Çıkış Yap", "Oturumu kapatmak istediğinize emin misiniz?", "warning", () => {
    stopScanner();
    localStorage.removeItem('karakus_user');
    location.reload();
  });
});
