/**
 * KARAKUŞ PLATFORM - FRONTEND ENGINE (v7.0 Professional)
 * GPS zorunludur. Tüm işlemler anlık olarak sunucuya kaydedilir.
 * KARAKUŞ PLATFORM - FRONTEND ENGINE (v8.0 Professional)
 * GPS ve Zaman Damgası (Barkod anı) zorunludur. Tüm işlemler anlık olarak sunucuya kaydedilir.
*/
const CONFIG = {
SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyXnLMCDiqyPHkM36MiLKo43SWCEeJTeMoKr_ZxHxA3SI_i71JyAuQciTDCpIr6DU9mUQ/exec',
CLIENT_ID: '653251016114-4340l82dqeldg25umf3749gr9b4aj8gn.apps.googleusercontent.com'
};

const CURRENT_SHIFT_KEY = 'karakus_current_shift';
const SHIFT_HISTORY_KEY = 'karakus_shift_history';

let currentUser = JSON.parse(localStorage.getItem('karakus_user'));
let html5QrCode = null;
let camState = 'idle';
let timerInterval = null;
let twelveHourNotified = false;

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
if (type === 'critical') iconEl.innerHTML = '<i class="fas fa-circle-exclamation" style="color: #ef4444;"></i>';
else if (type === 'success') iconEl.innerHTML = '<i class="fas fa-circle-check" style="color: #22c55e;"></i>';
else iconEl.innerHTML = '<i class="fas fa-triangle-exclamation" style="color: #f59e0b;"></i>';
modal.classList.remove('hidden');
document.getElementById('modalBtn').onclick = () => { modal.classList.add('hidden'); if (cb) cb(); };
}

// ================= PROGRESS / BİLDİRİM MODAL YÖNETİMİ (YENİ) =================
function showDevriyeProgress(title, message, iconClass = 'fa-spinner fa-spin', color = 'var(--primary)') {
  const modal = document.getElementById('devriyeActionModal');
  document.getElementById('devriyeTitle').textContent = title;
  document.getElementById('devriyeMessage').textContent = message;
  document.getElementById('devriyeIcon').innerHTML = `<i class="fas ${iconClass}" style="color: ${color};"></i>`;
  modal.classList.remove('hidden');
}

function hideDevriyeProgress() {
  document.getElementById('devriyeActionModal').classList.add('hidden');
}

function showGpsLoading() {
  document.getElementById('gpsLoadingModal').classList.remove('hidden');
}

function hideGpsLoading() {
  document.getElementById('gpsLoadingModal').classList.add('hidden');
}

// ================= AUTH =================
function initializeGoogleLogin() {
google.accounts.id.initialize({
client_id: CONFIG.CLIENT_ID, callback: handleCredentialResponse, auto_select: false, prompt: 'select_account'
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
showToast("Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.", "error");
}
}

function onLoginSuccess() {
document.getElementById('loginScreen').classList.add('hidden');
document.getElementById('mainScreen').classList.remove('hidden');
document.getElementById('displayName').textContent = currentUser.name;
document.getElementById('userInitial').textContent = currentUser.name.charAt(0).toUpperCase();
initScanner();
  loadCurrentShiftFromServer(); // Sunucudan mevcut mesai durumunu al
  loadCurrentShiftFromServer();
updateAttendanceUI();
document.getElementById('reportBtn').addEventListener('click', showReport);
}

// ================= NETWORK LISTENER (Sadece UI İçin) =================
// ================= NETWORK LISTENER =================
function initNetworkListeners() {
window.addEventListener('online', () => {
document.getElementById('networkStatus').innerHTML = '🟢 Çevrimiçi';
document.getElementById('networkStatus').style.color = '#2e7d32';
});
window.addEventListener('offline', () => {
document.getElementById('networkStatus').innerHTML = '🔴 Çevrimdışı';
document.getElementById('networkStatus').style.color = '#c62828';
});
}

// ================= SCANNER =================
async function initScanner() {
if (camState === 'starting' || camState === 'scanning') return;
camState = 'starting';
document.getElementById('scanResult').innerHTML = "⏳ Kamera başlatılıyor...";
try {
if (html5QrCode) { await html5QrCode.stop().catch(()=>{}); html5QrCode.clear(); }
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
if (html5QrCode && camState === 'scanning') { html5QrCode.stop().then(() => { camState = 'idle'; }).catch(()=>{}); }
}
document.getElementById('stopScanBtn').addEventListener('click', () => { stopScanner(); setTimeout(initScanner, 500); });

// ================= QR OKUMA & MESAİ YÖNLENDİRME =================
// ================= QR OKUMA & YÖNLENDİRME =================
function onScanSuccess(decodedText) {
if (camState === 'processing') return;
if (navigator.vibrate) navigator.vibrate(100);
playBeep();
  
  // ZAMAN DAMGASI - Barkodun okutulduğu an (KRİTİK MADDE 3)
  const barcodeTimestamp = new Date();
const cleanText = decodedText.trim().toUpperCase().replace(/İ/g, 'I');

if (cleanText === 'MESAI') {
camState = 'processing';
document.getElementById('scanResult').innerHTML = "🟡 Mesai işlemi hazırlanıyor...";
    // Önce GPS ve İnternet kontrolü yap
    checkPrerequisitesBeforeAction(() => {
      // Mesai İşlem Modalını aç
      document.getElementById('shiftActionModal').classList.remove('hidden');
      document.getElementById('scanResult').innerHTML = "🟢 Kamera aktif, barkod okutun.";
      camState = 'scanning';
    });
    // Mesai İşlem Modalını aç
    document.getElementById('shiftActionModal').classList.remove('hidden');
    document.getElementById('scanResult').innerHTML = "🟢 Kamera aktif, barkod okutun.";
    camState = 'scanning';
    
    // Butonlara tıklama olaylarını geçici olarak bağla, barcodeTimestamp'i aktar
    const startBtn = document.getElementById('startShiftBtn');
    const endBtn = document.getElementById('endShiftBtn');
    
    const newStartHandler = () => {
      document.getElementById('shiftActionModal').classList.add('hidden');
      handleStartShift(barcodeTimestamp);
      startBtn.removeEventListener('click', newStartHandler);
      endBtn.removeEventListener('click', newEndHandler);
    };
    const newEndHandler = () => {
      document.getElementById('shiftActionModal').classList.add('hidden');
      document.getElementById('confirmEndModal').classList.remove('hidden');
      endBtn.removeEventListener('click', newEndHandler);
      startBtn.removeEventListener('click', newStartHandler);
    };
    
    // Önceki dinleyicileri temizle (tekrarları önle)
    startBtn.replaceWith(startBtn.cloneNode(true));
    endBtn.replaceWith(endBtn.cloneNode(true));
    document.getElementById('startShiftBtn').addEventListener('click', newStartHandler);
    document.getElementById('endShiftBtn').addEventListener('click', newEndHandler);
return;
}

  // Normal devriye (korundu)
  // Normal devriye (Zaman damgası ile)
camState = 'processing';
document.getElementById('scanResult').innerHTML = "📍 Devriye kaydediliyor...";
if (navigator.geolocation) {
navigator.geolocation.getCurrentPosition(
      pos => processPatrolScan(decodedText, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      pos => processPatrolScan(decodedText, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, barcodeTimestamp),
err => { showToast("GPS alınamadı. Devriye kaydı için GPS zorunludur.", "error"); resumeScanner(); },
{ enableHighAccuracy: true, timeout: 8000 }
);
} else {
showToast("GPS desteği yok. İşlem iptal edildi.", "error");
resumeScanner();
}
}

function playBeep() {
try {
const audio = new Audio('data:audio/wav;base64,UklGRlAAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAACAgICAf39/f39/f3+AgICAf39/f39/f3+AgICAf39/f38=');
audio.volume = 0.3; audio.play().catch(() => {});
} catch(e) {}
}

function resumeScanner() {
document.getElementById('scanResult').innerHTML = "🟢 Sonraki nokta bekleniyor...";
setTimeout(() => { camState = 'scanning'; }, 2000);
}

// ================= DEVRİYE KAYDI (GPS Zorunlu) =================
async function processPatrolScan(qrText, lat, lng, accuracy) {
// ================= DEVRİYE KAYDI (PROFESYONEL POPUP İLE) =================
async function processPatrolScan(qrText, lat, lng, accuracy, barcodeTimestamp) {
if (!navigator.onLine) {
showToast("İnternet bağlantısı yok. Devriye kaydedilemedi.", "error");
resumeScanner(); return;
}

  // Popup göster
  showDevriyeProgress('Kayıt Oluşturuluyor', 'Lütfen bekleyiniz, veriler sunucuya iletilmektedir.', 'fa-spinner fa-spin', 'var(--primary)');

const payload = {
    action: 'saveScan', qrText: qrText, lat: lat, lng: lng, accuracy: accuracy,
    email: currentUser.email, name: currentUser.name, timestamp: new Date().toISOString()
    action: 'saveScan', 
    qrText: qrText, 
    lat: lat, 
    lng: lng, 
    accuracy: accuracy,
    barcodeTimestamp: barcodeTimestamp.toISOString(), // Barkod anı gönderiliyor
    email: currentUser.email, 
    name: currentUser.name
};

  document.getElementById('scanResult').innerHTML = "⏳ Veri sunucuya iletiliyor...";
try {
const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
    // Bağlantı ve HTTP hatası kontrolü
    if (!res.ok) throw new Error('HTTP Error ' + res.status);
    
const data = await res.json();
    if (data.status === 'success') showToast(`${qrText} başarıyla kaydedildi.`);
    else showToast(data.message, 'error');
    
    if (data.status === 'success') {
      showDevriyeProgress('Kayıt Başarıyla Tamamlandı', 'Devriye noktası sisteme kaydedildi.', 'fa-circle-check', 'var(--success)');
      setTimeout(() => {
        hideDevriyeProgress();
        showToast(`${qrText} başarıyla kaydedildi.`, 'success');
        resumeScanner();
      }, 1500);
    } else {
      showDevriyeProgress('Kayıt Başarısız', data.message || 'Bilinmeyen bir hata oluştu.', 'fa-circle-xmark', 'var(--error)');
      setTimeout(() => {
        hideDevriyeProgress();
        showToast(data.message || 'İşlem başarısız.', 'error');
        resumeScanner();
      }, 2000);
    }
} catch (error) {
    showToast("Ağ hatası. Devriye kaydedilemedi.", "error");
    console.error('Devriye Kayıt Hatası:', error);
    // SADECE gerçek ağ bağlantı hatalarında bu mesaj gösterilir
    showDevriyeProgress('Bağlantı Hatası', 'Sunucuya ulaşılamadı. Lütfen internet bağlantınızı kontrol edin.', 'fa-circle-xmark', 'var(--error)');
    setTimeout(() => {
      hideDevriyeProgress();
      showToast("Sunucu bağlantısı kurulamadı. Lütfen internet bağlantınızı kontrol edin.", "error");
      resumeScanner();
    }, 3000);
}
  resumeScanner();
}

// ================= MESAİ YÖNETİMİ (YENİ PROFESYONEL AKIŞ) =================
// ================= MESAİ YÖNETİMİ (YENİ AKIŞ) =================

// 1. Ön Koşul Kontrolü
function checkPrerequisitesBeforeAction(callback) {
  if (!navigator.onLine) {
    showModal("İnternet Bağlantısı Yok", "Bu işlemi gerçekleştirmek için internete bağlı olmalısınız. Lütfen bağlantınızı kontrol edin.", "critical");
    return;
  }
  if (!("geolocation" in navigator)) {
    showModal("GPS Eksik", "Cihazınızda GPS bulunamadı. Bu sistem için GPS zorunludur.", "critical");
    return;
  }
  callback();
}

// 2. Aktif Mesaiyi Sunucudan Çek
// 1. Aktif Mesaiyi Sunucudan Çek
async function loadCurrentShiftFromServer() {
if (!currentUser) return;
try {
const res = await fetch(CONFIG.SCRIPT_URL, {
method: 'POST',
body: JSON.stringify({ action: 'getCurrentShift', email: currentUser.email })
});
const data = await res.json();
if (data.status === 'success' && data.shift) {
localStorage.setItem(CURRENT_SHIFT_KEY, JSON.stringify(data.shift));
} else {
localStorage.removeItem(CURRENT_SHIFT_KEY);
}
updateAttendanceUI();
} catch (e) {
console.warn('Sunucudan mesai durumu alınamadı:', e);
}
}

// 3. MESAİ BAŞLAT
document.getElementById('startShiftBtn').addEventListener('click', async () => {
  document.getElementById('shiftActionModal').classList.add('hidden');
// 2. MESAİ BAŞLAT (GPS Bekleme Popup'ı ile)
async function handleStartShift(barcodeTimestamp) {
if (!navigator.onLine) { showToast("İnternet bağlantısı yok.", "error"); return; }

  showToast("Konum alınıyor... GPS bekleniyor.", "warning");
  // GPS Bekleme Modalını Aç
  showGpsLoading();

navigator.geolocation.getCurrentPosition(
async (pos) => {
try {
        hideGpsLoading(); // GPS alındı, modalı kapat
const res = await fetch(CONFIG.SCRIPT_URL, {
method: 'POST',
body: JSON.stringify({
action: 'startShift',
email: currentUser.email,
name: currentUser.name,
lat: pos.coords.latitude,
lng: pos.coords.longitude,
accuracy: pos.coords.accuracy,
            timestamp: new Date().toISOString(),
            barcode: 'MESAI'
            barcodeTimestamp: barcodeTimestamp.toISOString(), // KRİTİK: Barkod anı gönder
            userAgent: navigator.userAgent
})
});
        if (!res.ok) throw new Error('HTTP Error ' + res.status);
const data = await res.json();
if (data.status === 'success') {
localStorage.setItem(CURRENT_SHIFT_KEY, JSON.stringify(data.shift));
twelveHourNotified = false;
updateAttendanceUI();
showToast("✅ Mesai başlatıldı! Görev başlangıcı.", "success");
sendNotification('Mesai Başladı', 'Çalışma süreniz başlatıldı.');
} else {
showToast(data.message, 'error');
}
} catch (error) {
        showToast("Sunucu hatası. Mesai başlatılamadı.", "error");
        hideGpsLoading();
        showToast("Sunucu bağlantısı kurulamadı. Lütfen internet bağlantınızı kontrol edin.", "error");
}
},
(err) => {
      hideGpsLoading();
showModal("GPS Konum Hatası", "Mesai başlatmak için GPS konumunuz alınamadı. Lütfen konum izinlerini kontrol edip tekrar deneyin.", "critical");
},
    { enableHighAccuracy: true, timeout: 10000 }
    { enableHighAccuracy: true, timeout: 15000 }
);
});

// 4. MESAİ BİTİR (Önce Onay Modali Açılır)
document.getElementById('endShiftBtn').addEventListener('click', () => {
  document.getElementById('shiftActionModal').classList.add('hidden');
  // Bitirme işlemi için önce onay iste
  document.getElementById('confirmEndModal').classList.remove('hidden');
});
}

// Onayla (Mesai Bitir)
// 3. MESAİ BİTİR (Önce Onay Modali Açılır)
document.getElementById('confirmEndYes').addEventListener('click', async () => {
document.getElementById('confirmEndModal').classList.add('hidden');
if (!navigator.onLine) { showToast("İnternet bağlantısı yok.", "error"); return; }

  showToast("Konum alınıyor... GPS bekleniyor.", "warning");
  // GPS Bekleme Modalını Aç
  showGpsLoading();

navigator.geolocation.getCurrentPosition(
async (pos) => {
try {
        hideGpsLoading();
const res = await fetch(CONFIG.SCRIPT_URL, {
method: 'POST',
body: JSON.stringify({
action: 'endShift',
email: currentUser.email,
lat: pos.coords.latitude,
lng: pos.coords.longitude,
accuracy: pos.coords.accuracy,
            timestamp: new Date().toISOString(),
            barcode: 'MESAI'
            barcodeTimestamp: new Date().toISOString(), // Bitirme anı (QR okutulduğu an)
            userAgent: navigator.userAgent
})
});
        if (!res.ok) throw new Error('HTTP Error ' + res.status);
const data = await res.json();
if (data.status === 'success') {
          // Yerel kayıtları temizle ve geçmişe ekle
const endedShift = JSON.parse(localStorage.getItem(CURRENT_SHIFT_KEY));
endedShift.endTime = new Date().toISOString();
endedShift.durationSeconds = data.durationSeconds;
addToHistory(endedShift);
localStorage.removeItem(CURRENT_SHIFT_KEY);
twelveHourNotified = false;
updateAttendanceUI();
          showToast(`✅ Mesai tamamlandı! (${formatDuration(endedShift.durationSeconds)})`, "success");
          const durationStr = formatDurationHM(endedShift.durationSeconds);
          showToast(`✅ Mesai tamamlandı! (${durationStr})`, "success");
sendNotification('Mesai Bitti', 'Çalışma süreniz başarıyla sonlandırıldı.');
} else {
showToast(data.message, 'error');
}
} catch (error) {
        showToast("Sunucu hatası. Mesai bitirilemedi.", "error");
        hideGpsLoading();
        showToast("Sunucu bağlantısı kurulamadı. Lütfen internet bağlantınızı kontrol edin.", "error");
}
},
(err) => {
      hideGpsLoading();
showModal("GPS Konum Hatası", "Mesai bitirmek için GPS konumunuz alınamadı. Lütfen konum izinlerini kontrol edip tekrar deneyin.", "critical");
},
    { enableHighAccuracy: true, timeout: 10000 }
    { enableHighAccuracy: true, timeout: 15000 }
);
});

// Vazgeç
document.getElementById('confirmEndNo').addEventListener('click', () => {
document.getElementById('confirmEndModal').classList.add('hidden');
showToast("Mesai bitirme işlemi iptal edildi.", "warning");
});

// 5. MESAİ UI GÜNCELLEME + 12 SAAT / 13 SAAT KONTROLÜ
// ================= GEÇMİŞ KAYDI =================
function addToHistory(shift) {
  const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
  history.push({
    startTime: shift.startTime,
    endTime: shift.endTime,
    durationSeconds: shift.durationSeconds,
    isAutoEnded: shift.isAutoEnded || false,
    date: new Date(shift.startTime).toLocaleDateString('tr-TR')
  });
  localStorage.setItem(SHIFT_HISTORY_KEY, JSON.stringify(history));
}

// ================= SÜRE FORMATLARI =================
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// YENİ: Saat + Dakika formatı (Madde 6)
function formatDurationHM(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h} Saat ${m} Dakika`;
}

// ================= MESAİ UI GÜNCELLEME + 12 SAAT / 13 SAAT KONTROLÜ =================
function updateAttendanceUI() {
const shift = JSON.parse(localStorage.getItem(CURRENT_SHIFT_KEY));
const statusEl = document.getElementById('attStatus');
const timerEl = document.getElementById('attTimer');
const iconEl = document.getElementById('attIcon');

if (timerInterval) clearInterval(timerInterval);

if (!shift) {
    // Bugün mesai var mı diye history'ye bak
const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
const today = new Date().toDateString();
const lastShift = history.filter(s => new Date(s.startTime).toDateString() === today);
if (lastShift.length > 0) {
const last = lastShift[lastShift.length - 1];
      statusEl.textContent = `Bugün son mesai: ${formatDuration(last.durationSeconds)}`;
      statusEl.textContent = `Bugün son mesai: ${formatDurationHM(last.durationSeconds)}`;
timerEl.textContent = formatDuration(last.durationSeconds);
iconEl.innerHTML = '<i class="fas fa-flag-checkered" style="color: #ef4444;"></i>';
} else {
statusEl.textContent = 'Bugün mesai başlatılmadı';
timerEl.textContent = '00:00:00';
iconEl.innerHTML = '<i class="fas fa-clock"></i>';
}
return;
}

  // Aktif mesai var
statusEl.textContent = 'Mesai devam ediyor';
iconEl.innerHTML = '<i class="fas fa-play-circle" style="color: #22c55e;"></i>';

timerInterval = setInterval(() => {
const startTime = new Date(shift.startTime);
const now = new Date();
const elapsedSeconds = (now.getTime() - startTime.getTime()) / 1000;
timerEl.textContent = formatDuration(elapsedSeconds);

    // 12 SAAT KONTROLÜ
    if (elapsedSeconds >= 43200 && !twelveHourNotified) { // 12 saat = 43200 saniye
    if (elapsedSeconds >= 43200 && !twelveHourNotified) { // 12 saat
twelveHourNotified = true;
sendNotification('⚠️ 12 Saat Uyarısı', 'Mesainiz 12 saattir devam ediyor. Lütfen Mesai Barkodu\'nu okutarak mesainizi sonlandırınız.');
showToast('⚠️ 12 saat mesai uyarısı gönderildi.', 'warning');
}

    // 13 SAAT KONTROLÜ (Otomatik Sonlandırma)
    if (elapsedSeconds >= 46800) { // 13 saat = 46800 saniye
      // Sunucuya otomatik sonlandırma isteği at
    if (elapsedSeconds >= 46800) { // 13 saat
autoEndShiftFromFrontend();
}
}, 1000);
}

// 6. OTOMATİK SONLANDIRMA (13 Saat Kuralı)
// ================= OTOMATİK SONLANDIRMA (13 Saat) =================
let autoEndTriggered = false;
async function autoEndShiftFromFrontend() {
if (autoEndTriggered) return;
autoEndTriggered = true;
clearInterval(timerInterval);

try {
const res = await fetch(CONFIG.SCRIPT_URL, {
method: 'POST',
      body: JSON.stringify({
        action: 'autoEndShift',
        email: currentUser.email
      })
      body: JSON.stringify({ action: 'autoEndShift', email: currentUser.email })
});
    if (!res.ok) throw new Error('HTTP Error');
const data = await res.json();
if (data.status === 'success') {
const shift = JSON.parse(localStorage.getItem(CURRENT_SHIFT_KEY));
if(shift) {
shift.endTime = new Date().toISOString();
shift.durationSeconds = data.durationSeconds;
shift.isAutoEnded = true;
addToHistory(shift);
localStorage.removeItem(CURRENT_SHIFT_KEY);
twelveHourNotified = false;
updateAttendanceUI();
showToast("⚠️ Mesai 13 saat dolduğu için sistem tarafından otomatik sonlandırıldı.", "warning");
sendNotification('Mesai Otomatik Sonlandırıldı', '13 saat sınırı aşıldığı için mesainiz sistem tarafından kapatılmıştır.');
}
} else {
      // Eğer sunucu hata verdiyse (belki çoktan bitmiştir) lokal kaydı temizle
localStorage.removeItem(CURRENT_SHIFT_KEY);
updateAttendanceUI();
}
} catch (e) {
console.error('Otomatik sonlandırma hatası:', e);
showToast("Otomatik sonlandırma sırasında ağ hatası oluştu. Sistem sunucu tarafında kontrol edecektir.", "error");
    // Hataya rağmen UI'ı dondurmamak için sıfırla
autoEndTriggered = false;
updateAttendanceUI();
}
}

// ================= GEÇMİŞ KAYDI =================
function addToHistory(shift) {
  const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
  history.push({
    startTime: shift.startTime,
    endTime: shift.endTime,
    durationSeconds: shift.durationSeconds,
    isAutoEnded: shift.isAutoEnded || false,
    date: new Date(shift.startTime).toLocaleDateString('tr-TR')
  });
  localStorage.setItem(SHIFT_HISTORY_KEY, JSON.stringify(history));
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ================= RAPORLAMA (Yeni Alanlar Eklendi) =================
async function showReport() {
const modal = document.getElementById('reportModal');
const content = document.getElementById('reportContent');
modal.classList.remove('hidden');
content.innerHTML = `
   <div style="display:flex; justify-content:center; gap:10px; margin-bottom:20px;">
     <button class="btn btn-primary" onclick="fetchAndDisplayReport('week')" style="width:auto; padding:10px 18px;">📅 Bu Hafta</button>
     <button class="btn btn-primary" onclick="fetchAndDisplayReport('month')" style="width:auto; padding:10px 18px;">📅 Bu Ay</button>
   </div>
   <div style="display:flex; justify-content:center; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:15px;">
     <label style="font-size:14px; font-weight:600;">Özel Aralık:</label>
     <input type="date" id="reportStartDate" style="padding:6px; border:1px solid var(--border); border-radius:8px;">
     <span> - </span>
     <input type="date" id="reportEndDate" style="padding:6px; border:1px solid var(--border); border-radius:8px;">
     <button class="btn btn-primary" onclick="fetchAndDisplayReport('custom')" style="width:auto; padding:6px 14px;">Getir</button>
   </div>
   <div id="reportData" style="max-height:400px; overflow-y:auto;">
     <p style="color:#666; text-align:center;">Yukarıdan rapor dönemi seçiniz.</p>
   </div>
 `;

window.fetchAndDisplayReport = async (type) => {
const dataDiv = document.getElementById('reportData');
dataDiv.innerHTML = '<p style="color:#666; text-align:center;">⏳ Veriler yükleniyor...</p>';

let startDate, endDate = new Date();
const now = new Date();
if (type === 'week') {
const day = now.getDay() || 7; startDate = new Date(now); startDate.setDate(now.getDate() - day + 1); startDate.setHours(0,0,0,0); endDate = new Date(now);
} else if (type === 'month') {
startDate = new Date(now.getFullYear(), now.getMonth(), 1); endDate = new Date(now);
} else if (type === 'custom') {
startDate = new Date(document.getElementById('reportStartDate').value);
endDate = new Date(document.getElementById('reportEndDate').value);
if (!startDate || !endDate || startDate > endDate) { dataDiv.innerHTML = '<p style="color:red;">Lütfen geçerli bir tarih aralığı seçin.</p>'; return; }
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
      if (!res.ok) throw new Error('HTTP Error');
const data = await res.json();

if (data.status === 'success' && data.records.length > 0) {
let html = `<table><thead><tr>
         <th>Tarih</th><th>Başlangıç</th><th>Bitiş</th><th>Süre</th><th>Otomatik Sonlandırıldı</th>
       </tr></thead><tbody>`;
data.records.forEach(item => {
const start = new Date(item.startTime).toLocaleString('tr-TR');
const end = item.endTime ? new Date(item.endTime).toLocaleString('tr-TR') : '-';
          const dur = formatDuration(item.durationSeconds || 0);
          const dur = formatDurationHM(item.durationSeconds || 0);
const autoEnd = item.isAutoEnded ? '⚠️ Evet' : 'Hayır';
html += `<tr><td>${new Date(item.startTime).toLocaleDateString('tr-TR')}</td><td>${start}</td><td>${end}</td><td>${dur}</td><td>${autoEnd}</td></tr>`;
});
html += `</tbody></table>`;
dataDiv.innerHTML = html;
} else {
dataDiv.innerHTML = '<p class="empty">Bu döneme ait kayıt bulunamadı.</p>';
}
} catch (error) {
      dataDiv.innerHTML = '<p style="color:red;">Rapor yüklenirken hata oluştu.</p>';
      dataDiv.innerHTML = '<p style="color:red;">Rapor yüklenirken hata oluştu. Lütfen bağlantınızı kontrol edin.</p>';
}
};
}
document.getElementById('reportCloseBtn').addEventListener('click', () => { document.getElementById('reportModal').classList.add('hidden'); });

// ================= PUSH BİLDİRİM =================
function requestNotificationPermission() {
if (!('Notification' in window)) return;
if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
Notification.requestPermission();
}
function sendNotification(title, body) {
if (!('Notification' in window) || Notification.permission !== 'granted') return;
try { new Notification(title, { body, icon: 'logo.png' }); } catch(e) {}
}

// ================= ÇIKIŞ =================
document.getElementById('logoutBtn').addEventListener('click', () => {
showModal("Çıkış Yap", "Oturumu kapatmak istediğinize emin misiniz?", "warning", () => {
stopScanner(); clearInterval(timerInterval);
localStorage.removeItem('karakus_user');
location.reload();
});
});
