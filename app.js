/**
 * KARAKUŞ PLATFORM - FRONTEND ENGINE (Mesai Takibi Eklendi)
 */
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyXnLMCDiqyPHkM36MiLKo43SWCEeJTeMoKr_ZxHxA3SI_i71JyAuQciTDCpIr6DU9mUQ/exec', // << KENDİ URL'NİZLE DEĞİŞTİR
  CLIENT_ID: '653251016114-4340l82dqeldg25umf3749gr9b4aj8gn.apps.googleusercontent.com'
};

const ATTENDANCE_KEY = 'karakus_attendance';
const OFFLINE_ATT_KEY = 'karakus_offline_attendance';
const ATT_HISTORY_KEY = 'karakus_attendance_history'; // bitmiş mesailer lokal

let currentUser = JSON.parse(localStorage.getItem('karakus_user'));
let html5QrCode = null;
let camState = 'idle'; // idle, starting, scanning, processing
let timerInterval = null;

window.onload = () => {
  initNetworkListeners();
  if (currentUser && currentUser.sessionToken) {
    onLoginSuccess();
  } else {
    initializeGoogleLogin();
  }
  requestNotificationPermission(); // Push bildirim izni
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

function showModal(title, message, type = 'warning', cb = null) {
  const modal = document.getElementById('alertModal');
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalMessage').textContent = message;
  document.getElementById('modalTitle').style.color = type === 'critical' ? '#c62828' : '#f57f17';
  document.getElementById('modalIcon').textContent = type === 'critical' ? '⛔' : '⚠️';
  modal.classList.remove('hidden');
  document.getElementById('modalBtn').onclick = () => {
    modal.classList.add('hidden');
    if(cb) cb();
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
  fetchAdminWarnings();
  initScanner();
  updateAttendanceUI(); // Mesai durumunu ekrana getir
  // Manuel mesai butonu
  document.getElementById('manualClockBtn').addEventListener('click', () => {
    handleAttendance('MESAI');
  });
  // Rapor butonu
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
  // Devriye offline kayıtları
  const offlineScans = JSON.parse(localStorage.getItem('karakus_offline_scans') || '[]');
  if (offlineScans.length > 0 && navigator.onLine) {
    showToast(`${offlineScans.length} çevrimdışı devriye kaydı senkronize ediliyor...`, 'warning');
    try {
      await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'syncOffline', scans: offlineScans }) });
      localStorage.removeItem('karakus_offline_scans');
      showToast("Devriye kayıtları sunucuya aktarıldı.");
    } catch (e) { console.error("Sync hatası", e); }
  }

  // Mesai offline kayıtları
  const offlineAtt = JSON.parse(localStorage.getItem(OFFLINE_ATT_KEY) || '[]');
  if (offlineAtt.length > 0 && navigator.onLine) {
    showToast(`${offlineAtt.length} mesai kaydı senkronize ediliyor...`, 'warning');
    try {
      await fetch(CONFIG.SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ action: 'syncAttendance', records: offlineAtt })
      });
      localStorage.removeItem(OFFLINE_ATT_KEY);
      showToast("Mesai kayıtları sunucuya aktarıldı.");
    } catch (e) { console.error('Mesai senkronizasyon hatası', e); }
  }
}

// ================= SCANNER =================
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
  
// Mesai QR kontrolü (büyük/küçük harf duyarsız, boşluk yok)
if (decodedText.trim().toUpperCase() === 'MESAI') {
  camState = 'processing';
  handleAttendance(decodedText);
  return;
}

  // Normal devriye noktası
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

// ================= DEVRİYE KAYDI (MEVCUT) =================
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

// ================= MESAİ YÖNETİMİ (YENİ) =================
function handleAttendance(qrText) {
  // QR metni kontrolü (zaten yapıldı ama emniyet)
  if (qrText.trim() !== 'MESAI') return;

  const att = JSON.parse(localStorage.getItem(ATTENDANCE_KEY) || '{"status":"idle"}');
  
  if (att.status === 'idle') {
    // Mesai başlat
    att.status = 'started';
    att.startTime = new Date().toISOString();
    att.endTime = null;
    att.durationSeconds = 0;
    localStorage.setItem(ATTENDANCE_KEY, JSON.stringify(att));
    updateAttendanceUI();
    showToast('✅ Mesainiz başladı!', 'success');
    sendNotification('Mesai Başladı', 'Devriye görevinize başladınız. İyi çalışmalar!');
    // Çevrimdışıysa not al, online ise sunucuya clockIn gönderebiliriz (opsiyonel)
    // Şimdilik sadece local'de tutuyoruz.
    resumeScannerAfterAttendance();
  } 
  else if (att.status === 'started') {
    const start = new Date(att.startTime);
    const elapsed = (Date.now() - start.getTime()) / 1000 / 60; // dakika
    if (elapsed < 0,1) {
      showModal('Mesai Bitişi', `Henüz 1 saat dolmadı (${Math.floor(elapsed)} dk). Bitiş için en az 1 saat beklemelisiniz.`, 'warning');
      resumeScannerAfterAttendance();
      return;
    }
    // Mesai bitir
    att.status = 'ended';
    att.endTime = new Date().toISOString();
    att.durationSeconds = (Date.now() - start.getTime()) / 1000;
    localStorage.setItem(ATTENDANCE_KEY, JSON.stringify(att));
    
    // Geçmişe ekle (local history)
    addToHistory(att);
    
    updateAttendanceUI();
    const durationStr = formatDuration(att.durationSeconds);
    showToast(`✅ Mesainiz tamamlandı! (${durationStr})`, 'success');
    sendNotification('Mesai Bitti', `Bugünkü mesainiz ${durationStr} sürdü. Teşekkürler!`);
    
    // Sunucuya gönder (çevrimiçi ise)
    syncAttendanceToServer(att);
    resumeScannerAfterAttendance();
  } 
  else if (att.status === 'ended') {
    // Yeni mesai başlat (önceki bitmiş)
    showModal('Yeni Mesai', 'Önceki mesai tamamlandı. Yeni mesai başlatılsın mı?', 'warning', () => {
      const newAtt = { status: 'started', startTime: new Date().toISOString(), endTime: null, durationSeconds: 0 };
      localStorage.setItem(ATTENDANCE_KEY, JSON.stringify(newAtt));
      updateAttendanceUI();
      showToast('✅ Yeni mesai başladı!', 'success');
      sendNotification('Mesai Başladı', 'Yeni bir mesai dönemi başlatıldı.');
      resumeScannerAfterAttendance();
    });
  }
}

function resumeScannerAfterAttendance() {
  // Kamera durumunu tekrar scanning yap
  setTimeout(() => {
    camState = 'scanning';
    document.getElementById('scanResult').innerHTML = "🟢 Kamera aktif, barkod okutun.";
  }, 1500);
}

// Mesai geçmişine ekle (local)
function addToHistory(att) {
  const history = JSON.parse(localStorage.getItem(ATT_HISTORY_KEY) || '[]');
  history.push({
    startTime: att.startTime,
    endTime: att.endTime,
    durationSeconds: att.durationSeconds,
    date: new Date(att.startTime).toLocaleDateString('tr-TR')
  });
  localStorage.setItem(ATT_HISTORY_KEY, JSON.stringify(history));
}

// Sunucuya mesai bitişini gönder
async function syncAttendanceToServer(att) {
  if (!navigator.onLine) {
    // Offline ise offline listesine ekle
    const offline = JSON.parse(localStorage.getItem(OFFLINE_ATT_KEY) || '[]');
    offline.push({
      email: currentUser.email,
      name: currentUser.name,
      startTime: att.startTime,
      endTime: att.endTime,
      durationSeconds: att.durationSeconds
    });
    localStorage.setItem(OFFLINE_ATT_KEY, JSON.stringify(offline));
    return;
  }

  try {
    await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({
        action: 'clockOut',
        email: currentUser.email,
        name: currentUser.name,
        startTime: att.startTime,
        endTime: att.endTime,
        durationSeconds: att.durationSeconds
      })
    });
  } catch(e) {
    console.warn('Mesai senkronizasyon hatası', e);
    // Hata durumunda offline'a al
    const offline = JSON.parse(localStorage.getItem(OFFLINE_ATT_KEY) || '[]');
    offline.push({
      email: currentUser.email,
      name: currentUser.name,
      startTime: att.startTime,
      endTime: att.endTime,
      durationSeconds: att.durationSeconds
    });
    localStorage.setItem(OFFLINE_ATT_KEY, JSON.stringify(offline));
  }
}

// ================= MESAİ UI GÜNCELLEME =================
function updateAttendanceUI() {
  const att = JSON.parse(localStorage.getItem(ATTENDANCE_KEY) || '{"status":"idle"}');
  const statusEl = document.getElementById('attStatus');
  const timerEl = document.getElementById('attTimer');
  const iconEl = document.getElementById('attIcon');
  const manualBtn = document.getElementById('manualClockBtn');
  
  if (timerInterval) clearInterval(timerInterval);

  if (att.status === 'idle') {
    statusEl.textContent = 'Mesai başlatılmadı';
    timerEl.textContent = '00:00:00';
    iconEl.textContent = '🕒';
    manualBtn.textContent = '⏱️ Mesai Başlat';
  } else if (att.status === 'started') {
    statusEl.textContent = 'Mesai devam ediyor';
    iconEl.textContent = '🟢';
    manualBtn.textContent = '⏹️ Mesai Bitir (QR)';
    // Timer'ı başlat
    timerInterval = setInterval(() => {
      const elapsed = (Date.now() - new Date(att.startTime).getTime()) / 1000;
      timerEl.textContent = formatDuration(elapsed);
    }, 1000);
  } else if (att.status === 'ended') {
    statusEl.textContent = `Mesai tamamlandı (${formatDuration(att.durationSeconds)})`;
    timerEl.textContent = formatDuration(att.durationSeconds);
    iconEl.textContent = '🔴';
    manualBtn.textContent = '⏱️ Yeni Mesai Başlat';
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ================= MESAİ RAPORU (Offline + Online) =================
async function showReport() {
  const modal = document.getElementById('reportModal');
  const content = document.getElementById('reportContent');
  modal.classList.remove('hidden');
  content.innerHTML = '<p style="color:#666;">Yükleniyor...</p>';

  // Önce local geçmişi al
  let localHistory = JSON.parse(localStorage.getItem(ATT_HISTORY_KEY) || '[]');
  
  // Eğer çevrimiçi ise sunucudan da al ve birleştir (tekrar edenleri önlemek için tarih bazlı filtreleme yapılabilir)
  if (navigator.onLine) {
    try {
      const res = await fetch(CONFIG.SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ action: 'getAttendance', email: currentUser.email })
      });
      const data = await res.json();
      if (data.status === 'success' && data.records) {
        // Sunucudaki kayıtları local'e ekle (eğer yoksa)
        // Basitçe localHistory'yi sunucu verileriyle birleştirip unique yapalım (startTime bazında)
        const allRecords = [...localHistory, ...data.records];
        const unique = allRecords.filter((v, i, a) => a.findIndex(t => t.startTime === v.startTime) === i);
        localHistory = unique;
        // Tekrar localStorage'a yaz
        localStorage.setItem(ATT_HISTORY_KEY, JSON.stringify(localHistory));
      }
    } catch(e) {
      console.warn('Sunucudan rapor alınamadı', e);
    }
  }

  // Tabloyu oluştur
  if (localHistory.length === 0) {
    content.innerHTML = '<p class="empty">Henüz hiç mesai kaydınız yok.</p>';
  } else {
    let html = `<table>
      <thead><tr><th>Tarih</th><th>Başlangıç</th><th>Bitiş</th><th>Süre</th></tr></thead><tbody>`;
    // Tarihe göre sırala (en yeni en üstte)
    localHistory.sort((a,b) => new Date(b.startTime) - new Date(a.startTime));
    localHistory.forEach(item => {
      const start = new Date(item.startTime).toLocaleString('tr-TR');
      const end = item.endTime ? new Date(item.endTime).toLocaleString('tr-TR') : '-';
      const dur = formatDuration(item.durationSeconds || 0);
      const date = new Date(item.startTime).toLocaleDateString('tr-TR');
      html += `<tr><td>${date}</td><td>${start}</td><td>${end}</td><td>${dur}</td></tr>`;
    });
    html += `</tbody></table>`;
    content.innerHTML = html;
  }
}

document.getElementById('reportCloseBtn').addEventListener('click', () => {
  document.getElementById('reportModal').classList.add('hidden');
});

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

// ================= YÖNETİCİ UYARILARI =================
async function fetchAdminWarnings() {
  const dismissedAt = localStorage.getItem('karakus_warning_dismissed_at');
  if (dismissedAt) {
    const hoursPassed = (new Date() - new Date(dismissedAt)) / (1000 * 60 * 60);
    if (hoursPassed < 8) return;
  }

  try {
    const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'getWarning' }) });
    const data = await res.json();
    if (data.warning) {
      showModal("Yönetici Mesajı", data.warning, data.type);
      localStorage.setItem('karakus_warning_dismissed_at', new Date().toISOString());
    }
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
