/**
 * KARAKUŞ PLATFORM - FRONTEND ENGINE
 */
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyXnLMCDiqyPHkM36MiLKo43SWCEeJTeMoKr_ZxHxA3SI_i71JyAuQciTDCpIr6DU9mUQ/exec', // << DEĞİŞTİR
  CLIENT_ID: '653251016114-4340l82dqeldg25umf3749gr9b4aj8gn.apps.googleusercontent.com'
};

let currentUser = JSON.parse(localStorage.getItem('karakus_user'));
let html5QrCode = null;
let camState = 'idle'; // idle, starting, scanning, processing

window.onload = () => {
  initNetworkListeners();
  if (currentUser && currentUser.sessionToken) {
    onLoginSuccess();
  } else {
    initializeGoogleLogin();
  }
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

// ================= AUTHENTICATION =================
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
  const offlineScans = JSON.parse(localStorage.getItem('karakus_offline_scans') || '[]');
  if (offlineScans.length === 0 || !navigator.onLine) return;
  
  showToast(`${offlineScans.length} çevrimdışı kayıt senkronize ediliyor...`, 'warning');
  try {
    await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'syncOffline', scans: offlineScans }) });
    localStorage.removeItem('karakus_offline_scans');
    showToast("Tüm kayıtlar sunucuya aktarıldı.");
  } catch (e) {
    console.error("Sync hatası", e);
  }
}

// ================= SCANNER STATE MACHINE =================
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
    
    // Fallback'li kamera başlatma (önce arka, olmazsa genel)
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

// ================= DATA PROCESSING =================
function onScanSuccess(decodedText) {
  if (camState === 'processing') return;
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
  setTimeout(() => { camState = 'scanning'; }, 2000); // 2 saniye kilitlenme
}

async function fetchAdminWarnings() {
  // 8 saatlik gizleme kontrolü
  const dismissedAt = localStorage.getItem('karakus_warning_dismissed_at');
  if (dismissedAt) {
    const hoursPassed = (new Date() - new Date(dismissedAt)) / (1000 * 60 * 60);
    if (hoursPassed < 8) return; // 8 saat geçmediyse uyarılardan çık, gösterme
  }

  try {
    const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'getWarning' }) });
    const data = await res.json();
    if (data.warning) {
      // Kullanıcı modalda "Okudum" butonuna bastığında tetiklenecek callback fonksiyonu
      showModal("Yönetici Mesajı", data.warning, data.type, () => {
        localStorage.setItem('karakus_warning_dismissed_at', new Date().toISOString());
      });
    }
  } catch(e) {}
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  showModal("Çıkış Yap", "Oturumu kapatmak istediğinize emin misiniz?", "warning", () => {
    stopScanner();
    localStorage.removeItem('karakus_user');
    location.reload();
  });
});
