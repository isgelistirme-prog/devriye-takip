/**
 * KARAKUŞ PLATFORM - FRONTEND ENGINE (v9.1 Professional)
 * Özellikler: Merkezi LocationManager, Transaction Queue, Retry Pattern, Exponential Backoff, Diagnostic Engine
 * Kullanıcı teknik hata görmez, tüm işlemler arka planda çözülür.
 */
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyXnLMCDiqyPHkM36MiLKo43SWCEeJTeMoKr_ZxHxA3SI_i71JyAuQciTDCpIr6DU9mUQ/exec',
  CLIENT_ID: '653251016114-4340l82dqeldg25umf3749gr9b4aj8gn.apps.googleusercontent.com',
  LOCATION_RETRY_TIMES: [0, 5, 15, 30, 60, 120, 300, 600] // saniye cinsinden
};

const CURRENT_SHIFT_KEY = 'karakus_current_shift';
const SHIFT_HISTORY_KEY = 'karakus_shift_history';
const PENDING_TRANSACTIONS_KEY = 'karakus_pending_transactions';

let currentUser = JSON.parse(localStorage.getItem('karakus_user'));
let html5QrCode = null;
let camState = 'idle';
let timerInterval = null;
let twelveHourNotified = false;
let locationManager = null;
let transactionQueue = null;

// ====================== LOCATION MANAGER (Merkezi Konum Servisi) ======================
class LocationManager {
  constructor() {
    this.watchId = null;
    this.lastKnownLocation = null;
    this.lastKnownTimestamp = null;
    this.permissionState = 'prompt'; // prompt, granted, denied, unavailable
    this.isWatching = false;
    this.retryAttempt = 0;
    this.errorCount = 0;
    this.listeners = [];
    this.maxRetrySeconds = 600; // 10 dakika
  }

  startWatching() {
    if (this.isWatching) return;
    if (!navigator.geolocation) {
      this.permissionState = 'unavailable';
      return;
    }
    
    this.isWatching = true;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.lastKnownLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };
        this.lastKnownTimestamp = Date.now();
        this.permissionState = 'granted';
        this.errorCount = 0;
        this.retryAttempt = 0;
        this.notifyListeners('location_updated', this.lastKnownLocation);
      },
      (err) => {
        this.errorCount++;
        const code = err.code;
        if (code === 1) {
          this.permissionState = 'denied';
        } else if (code === 2) {
          this.permissionState = 'unavailable';
        } else if (code === 3) {
          this.permissionState = 'timeout';
        }
        this.notifyListeners('location_error', { code, message: err.message });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  stopWatching() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.isWatching = false;
  }

  getCachedLocation() {
    if (!this.lastKnownLocation) return null;
    // Konum 2 dakikadan eskiyse geçersiz say
    if (Date.now() - this.lastKnownTimestamp > 120000) return null;
    return this.lastKnownLocation;
  }

  async forceGetLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject({ error: 'unavailable' });
        return;
      }
      
      // İzin durumunu kontrol et
      if (this.permissionState === 'denied') {
        reject({ error: 'permission_denied' });
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.lastKnownLocation = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          };
          this.lastKnownTimestamp = Date.now();
          this.permissionState = 'granted';
          resolve(this.lastKnownLocation);
        },
        (err) => {
          this.errorCount++;
          if (err.code === 1) this.permissionState = 'denied';
          else if (err.code === 2) this.permissionState = 'unavailable';
          else if (err.code === 3) this.permissionState = 'timeout';
          reject({ error: this.permissionState, message: err.message });
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  addListener(callback) {
    this.listeners.push(callback);
  }

  notifyListeners(type, data) {
    this.listeners.forEach(cb => cb(type, data));
  }

  getDiagnosticData() {
    return {
      permissionState: this.permissionState,
      errorCount: this.errorCount,
      retryAttempt: this.retryAttempt,
      hasLocation: !!this.lastKnownLocation,
      locationAge: this.lastKnownTimestamp ? (Date.now() - this.lastKnownTimestamp) / 1000 : -1,
      accuracy: this.lastKnownLocation ? this.lastKnownLocation.accuracy : -1,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      isOnline: navigator.onLine,
      isPWA: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone
    };
  }
}

// ====================== TRANSACTION QUEUE (İşlem Kuyruğu Yönetimi) ======================
class TransactionQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.loadFromStorage();
  }

  loadFromStorage() {
    try {
      const stored = localStorage.getItem(PENDING_TRANSACTIONS_KEY);
      if (stored) {
        this.queue = JSON.parse(stored);
        // Zaman aşımına uğramış işlemleri temizle (10 dakika)
        const now = Date.now();
        const maxAge = 600000; // 10 dakika
        this.queue = this.queue.filter(tx => (now - tx.createdAt) < maxAge);
        this.saveToStorage();
      }
    } catch (e) {
      this.queue = [];
    }
  }

  saveToStorage() {
    try {
      localStorage.setItem(PENDING_TRANSACTIONS_KEY, JSON.stringify(this.queue));
    } catch (e) {
      console.warn('Storage write failed:', e);
    }
  }

  addTransaction(transaction) {
    // Double submit ve Duplicate kontrolü
    const exists = this.queue.find(tx => tx.transactionId === transaction.transactionId);
    if (exists) return;
    this.queue.push(transaction);
    this.saveToStorage();
    this.processQueue();
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const pending = this.queue.filter(tx => !tx.isCompleted);
    for (let tx of pending) {
      await this.retryTransaction(tx);
    }

    this.isProcessing = false;
    if (this.queue.length > 0) {
      // Kalanlar varsa periyodik olarak devam et
      setTimeout(() => this.processQueue(), 15000);
    }
  }

  async retryTransaction(tx) {
    const now = Date.now();
    const elapsed = (now - tx.createdAt) / 1000;

    // 10 dakika (600 saniye) dolduysa zaman aşımı
    const isExpired = elapsed > 600;

    // 1. SHIFT_END (Mesai Bitirme) İşlemi Özel Mantığı
    if (tx.type === 'shift_end') {
      // Konum bulunduysa veya süre dolduysa (her iki durumda da mesaiyi bitir)
      const loc = locationManager.getCachedLocation();
      
      // Konum varsa veya süre dolduysa, EndShift işlemini tetikle
      if (loc || isExpired) {
        await this.endShiftFromQueue(tx, loc);
        return;
      }
      
      // Konum yoksa ve süre dolmadıysa, retry count'u artır ve bekle
      tx.retryCount++;
      this.saveToStorage();
      return;
    }

    // 2. PATROL ve SHIFT_START İşlemleri (Sadece Konum Güncellemesi)
    // Süre dolduysa ve konum yoksa başarısız raporla
    if (isExpired && !locationManager.getCachedLocation()) {
      tx.isCompleted = true;
      tx.isFailed = true;
      tx.failureReason = 'timeout_expired';
      this.saveToStorage();
      await this.reportFailure(tx);
      return;
    }

    // Exponential Backoff kontrolü
    const nextInterval = CONFIG.LOCATION_RETRY_TIMES[tx.retryCount] || 600;
    if (elapsed < nextInterval) return; // Henüz sırası gelmedi

    const loc = locationManager.getCachedLocation();
    if (loc) {
      // Konum bulundu
      tx.isCompleted = true;
      tx.isFailed = false;
      tx.location = loc;
      this.saveToStorage();
      await this.updateLocation(tx);
      return;
    }

    // Hala yoksa ve izin reddedilmişse denemeyi bırak ve raporla
    if (locationManager.permissionState === 'denied') {
      tx.isCompleted = true;
      tx.isFailed = true;
      tx.failureReason = 'permission_denied';
      this.saveToStorage();
      await this.reportFailure(tx);
      return;
    }

    // Yeniden dene
    tx.retryCount++;
    this.saveToStorage();
    locationManager.retryAttempt = tx.retryCount;

    try {
      await locationManager.forceGetLocation();
      // Başarılı olursa, bir sonraki döngüde yukarıdaki location check çalışacak
    } catch (err) {
      console.log(`Retry ${tx.retryCount} for ${tx.transactionId} failed:`, err.error);
    }
  }

  // Mesai bitirme işlemini tamamlayan özel fonksiyon
  async endShiftFromQueue(tx, location) {
    const payload = {
      action: 'endShift',
      email: tx.email,
      barcodeTimestamp: tx.barcodeTimestamp || new Date().toISOString(),
      userAgent: tx.userAgent || navigator.userAgent
    };

    if (location) {
      payload.lat = location.lat;
      payload.lng = location.lng;
      payload.accuracy = location.accuracy;
    }

    try {
      const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('HTTP Error');
      const data = await res.json();

      if (data.status === 'success') {
        // UI ve LocalStorage Güncellemesi
        const endedShift = JSON.parse(localStorage.getItem(CURRENT_SHIFT_KEY));
        if (endedShift) {
          endedShift.endTime = new Date().toISOString();
          endedShift.durationSeconds = data.durationSeconds;
          addToHistory(endedShift);
          localStorage.removeItem(CURRENT_SHIFT_KEY);
          twelveHourNotified = false;
          updateAttendanceUI();
          
          if (location) {
            showToast(`✅ Mesai tamamlandı! (${formatDurationHM(endedShift.durationSeconds)})`, "success");
            sendNotification('Mesai Bitti', 'Çalışma süreniz başarıyla sonlandırıldı.');
          } else {
            showToast(`⚠️ Mesai tamamlandı (Konum alınamadı). (${formatDurationHM(endedShift.durationSeconds)})`, "warning");
            sendNotification('Mesai Bitti', 'Konum alınamadığı için mesai manuel olarak onaylandı.');
          }
        }
        this.removeFromQueue(tx.transactionId);
      } else {
        throw new Error(data.message || 'Bilinmeyen hata');
      }
    } catch (error) {
      console.error('EndShift from queue failed:', error);
      // Hata durumunda işlemi iptal etme, bir sonraki döngüde tekrar dene
      // Eğer süre dolduysa ve hala hata alınıyorsa, raporla
      if (this.isExpired(tx)) {
        tx.isCompleted = true;
        tx.isFailed = true;
        tx.failureReason = 'end_shift_api_failed';
        this.saveToStorage();
        await this.reportFailure(tx);
      }
    }
  }

  async updateLocation(tx) {
    const payload = {
      action: tx.type === 'shift_start' ? 'updateShiftLocation' : 'updateTransactionLocation',
      transactionId: tx.transactionId,
      lat: tx.location.lat,
      lng: tx.location.lng,
      accuracy: tx.location.accuracy
    };
    try {
      const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('HTTP Error');
      const data = await res.json();
      if (data.status === 'success') {
        showToast('Konum bilgisi sisteme başarıyla iletildi.', 'success');
        this.removeFromQueue(tx.transactionId);
      } else {
        throw new Error(data.message);
      }
    } catch (e) {
      console.error('Location update failed:', e);
      // Ağ hatasında işlemi iptal etme, kuyrukta kalsın
    }
  }

  async reportFailure(tx) {
    const diagnostic = locationManager.getDiagnosticData();
    diagnostic.retryCount = tx.retryCount;
    diagnostic.failureReason = tx.failureReason;

    let action = 'reportTransactionFailure';
    if (tx.type === 'shift_start') action = 'reportShiftFailure';
    else if (tx.type === 'shift_end') action = 'reportShiftFailure';

    const payload = {
      action: action,
      transactionId: tx.transactionId,
      diagnosticData: JSON.stringify(diagnostic)
    };
    try {
      const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('HTTP Error');
      const data = await res.json();
      if (data.status === 'success') {
        showToast('Konum alınamadı. Sistem işlemi arka planda tamamladı.', 'warning');
        this.removeFromQueue(tx.transactionId);
      }
    } catch (e) {
      console.error('Failure report failed:', e);
    }
  }

  isExpired(tx) {
    return (Date.now() - tx.createdAt) > 600000;
  }

  removeFromQueue(transactionId) {
    this.queue = this.queue.filter(tx => tx.transactionId !== transactionId);
    this.saveToStorage();
  }
}

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

// ================= PROGRESS / BİLDİRİM MODAL YÖNETİMİ =================
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
  
  // Servisleri başlat
  locationManager = new LocationManager();
  transactionQueue = new TransactionQueue();
  locationManager.startWatching();
  
  // Sayfa görünürlüğü değiştiğinde kuyruğu işle
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && transactionQueue) {
      transactionQueue.processQueue();
    }
  });
  window.addEventListener('focus', () => {
    if (transactionQueue) transactionQueue.processQueue();
  });

  // Eski sistemin diğer başlatıcıları
  initScanner();
  loadCurrentShiftFromServer();
  updateAttendanceUI();
  document.getElementById('reportBtn').addEventListener('click', showReport);
}

// ================= NETWORK LISTENER =================
function initNetworkListeners() {
  window.addEventListener('online', () => {
    document.getElementById('networkStatus').innerHTML = '🟢 Çevrimiçi';
    document.getElementById('networkStatus').style.color = '#2e7d32';
    if (transactionQueue) transactionQueue.processQueue();
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

// ================= QR OKUMA & YÖNLENDİRME (YENİ TRANSACTION AKIŞI) =================
function onScanSuccess(decodedText) {
  if (camState === 'processing') return;
  if (navigator.vibrate) navigator.vibrate(100);
  playBeep();
  
  const barcodeTimestamp = new Date();
  const cleanText = decodedText.trim().toUpperCase().replace(/İ/g, 'I');
  
  if (cleanText === 'MESAI') {
    camState = 'processing';
    document.getElementById('scanResult').innerHTML = "🟡 Mesai işlemi hazırlanıyor...";
    document.getElementById('shiftActionModal').classList.remove('hidden');
    document.getElementById('scanResult').innerHTML = "🟢 Kamera aktif, barkod okutun.";
    camState = 'scanning';
    
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
    
    startBtn.replaceWith(startBtn.cloneNode(true));
    endBtn.replaceWith(endBtn.cloneNode(true));
    document.getElementById('startShiftBtn').addEventListener('click', newStartHandler);
    document.getElementById('endShiftBtn').addEventListener('click', newEndHandler);
    return;
  }

  // Normal devriye (Transaction Tabanlı, GPS Beklemez)
  camState = 'processing';
  document.getElementById('scanResult').innerHTML = "📍 Devriye kaydediliyor...";
  
  // İşlemi hemen sunucuya gönder, konum beklenmez
  processPatrolScan(cleanText, barcodeTimestamp);
}

function playBeep() {
  try {
    const audio = new Audio('data:audio/wav;base64,UklGRlAAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAACAgICAf39/f39/f3+AgICAf39/f39/f3+AgICAf39/f38=');
    audio.volume = 0.3; audio.play().catch(() => {});
  } catch(e) {}
}

function resumeScanner() {
  document.getElementById('scanResult').innerHTML = "🟢 Sonraki nokta bekleniyor...";
  setTimeout(() => { camState = 'scanning'; }, 1500);
}

// ================= DEVRİYE KAYDI (YENİ PROFESYONEL AKIŞ) =================
async function processPatrolScan(qrText, barcodeTimestamp) {
  if (!navigator.onLine) {
    showToast("İnternet bağlantısı yok. İşlem cihazda beklemede.", "warning");
    // Offline durumda bile kuyruğa al
    createTransactionLocally(qrText, barcodeTimestamp);
    resumeScanner();
    return;
  }

  // İşlemi anında sunucuya gönder (createTransaction)
  const transactionId = generateUUID();
  const payload = {
    action: 'createTransaction',
    transactionId: transactionId,
    qrText: qrText,
    barcodeTimestamp: barcodeTimestamp.toISOString(),
    email: currentUser.email,
    name: currentUser.name
  };

  try {
    const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('HTTP Error ' + res.status);
    const data = await res.json();
    
    if (data.status === 'success') {
      // Kullanıcıya sadece başarılı olduğu bilgisi ver
      showToast(`${qrText} başarıyla kaydedildi.`, 'success');
      resumeScanner();
      
      // Kuyruğa ekle (Konum güncellemesi için)
      transactionQueue.addTransaction({
        transactionId: transactionId,
        qrText: qrText,
        type: 'patrol',
        createdAt: Date.now(),
        retryCount: 0,
        isCompleted: false,
        isFailed: false
      });
    } else {
      showToast(data.message || 'İşlem başarısız.', 'error');
      resumeScanner();
    }
  } catch (error) {
    console.error('Devriye Kayıt Hatası:', error);
    // Sunucuya gidemezse yerel kuyruğa al
    createTransactionLocally(qrText, barcodeTimestamp);
    showToast("Sunucu bağlantısı kurulamadı. İşlem beklemede.", "warning");
    resumeScanner();
  }
}

// Yerel (Offline) işlem oluşturma
function createTransactionLocally(qrText, barcodeTimestamp) {
  const transactionId = generateUUID();
  transactionQueue.addTransaction({
    transactionId: transactionId,
    qrText: qrText,
    barcodeTimestamp: barcodeTimestamp.toISOString(),
    email: currentUser.email,
    name: currentUser.name,
    type: 'patrol',
    createdAt: Date.now(),
    retryCount: 0,
    isCompleted: false,
    isFailed: false,
    isOffline: true
  });
}

// ================= MESAİ YÖNETİMİ (YENİ AKIŞ) =================

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

async function handleStartShift(barcodeTimestamp) {
  if (!navigator.onLine) { 
    showToast("İnternet yok. Mesai başlatma isteği kuyruğa alındı.", "warning");
    createShiftTransactionLocally('start', barcodeTimestamp);
    return; 
  }

  const transactionId = generateUUID();
  const payload = {
    action: 'createShiftTransaction',
    transactionId: transactionId,
    email: currentUser.email,
    name: currentUser.name,
    barcodeTimestamp: barcodeTimestamp.toISOString(),
    userAgent: navigator.userAgent
  };

  try {
    const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('HTTP Error ' + res.status);
    const data = await res.json();
    
    if (data.status === 'success') {
      twelveHourNotified = false;
      updateAttendanceUI();
      showToast("✅ Mesai başlatıldı! Görev başlangıcı.", "success");
      sendNotification('Mesai Başladı', 'Çalışma süreniz başlatıldı.');
      
      // Kuyruğa ekle (Konum güncellemesi için)
      transactionQueue.addTransaction({
        transactionId: transactionId,
        type: 'shift_start',
        email: currentUser.email,
        name: currentUser.name,
        userAgent: navigator.userAgent,
        createdAt: Date.now(),
        retryCount: 0,
        isCompleted: false,
        isFailed: false
      });
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    createShiftTransactionLocally('start', barcodeTimestamp);
    showToast("Sunucu bağlantısı kurulamadı. İşlem beklemede.", "warning");
  }
}

function createShiftTransactionLocally(type, barcodeTimestamp) {
  const transactionId = generateUUID();
  transactionQueue.addTransaction({
    transactionId: transactionId,
    type: type === 'start' ? 'shift_start' : 'shift_end',
    email: currentUser.email,
    name: currentUser.name,
    barcodeTimestamp: barcodeTimestamp.toISOString(),
    userAgent: navigator.userAgent,
    createdAt: Date.now(),
    retryCount: 0,
    isCompleted: false,
    isFailed: false,
    isOffline: true
  });
}

document.getElementById('confirmEndYes').addEventListener('click', async () => {
  document.getElementById('confirmEndModal').classList.add('hidden');
  
  // Önce mevcut konumu dene
  let loc = locationManager.getCachedLocation();
  if (!loc) {
    try {
      loc = await locationManager.forceGetLocation();
    } catch (err) {
      // Konum alınamazsa işlemi kuyruğa al
      showToast("Konum alınamadı. İşlem kuyruğa alındı, sistem konumu algıladığında veya süre dolduğunda tamamlayacak.", "warning");
      createShiftTransactionLocally('end', new Date());
      return;
    }
  }

  // Konum varsa veya anında alındıysa doğrudan bitir
  if (loc && navigator.onLine) {
    const payload = {
      action: 'endShift',
      email: currentUser.email,
      barcodeTimestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      lat: loc.lat,
      lng: loc.lng,
      accuracy: loc.accuracy
    };
    try {
      const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('HTTP Error ' + res.status);
      const data = await res.json();
      if (data.status === 'success') {
        const endedShift = JSON.parse(localStorage.getItem(CURRENT_SHIFT_KEY));
        endedShift.endTime = new Date().toISOString();
        endedShift.durationSeconds = data.durationSeconds;
        addToHistory(endedShift);
        localStorage.removeItem(CURRENT_SHIFT_KEY);
        twelveHourNotified = false;
        updateAttendanceUI();
        const durationStr = formatDurationHM(endedShift.durationSeconds);
        showToast(`✅ Mesai tamamlandı! (${durationStr})`, "success");
        sendNotification('Mesai Bitti', 'Çalışma süreniz başarıyla sonlandırıldı.');
      } else {
        showToast(data.message, 'error');
      }
    } catch (error) {
      showToast("Sunucu bağlantısı kurulamadı. İşlem kuyruğa alındı.", "error");
      createShiftTransactionLocally('end', new Date());
    }
  } else {
    // Internet yoksa veya konum yoksa kuyruğa al
    createShiftTransactionLocally('end', new Date());
    if (!navigator.onLine) {
      showToast("İnternet yok. Mesai bitirme isteği kuyruğa alındı.", "warning");
    }
  }
});

document.getElementById('confirmEndNo').addEventListener('click', () => {
  document.getElementById('confirmEndModal').classList.add('hidden');
  showToast("Mesai bitirme işlemi iptal edildi.", "warning");
});

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
    const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
    const today = new Date().toDateString();
    const lastShift = history.filter(s => new Date(s.startTime).toDateString() === today);
    if (lastShift.length > 0) {
      const last = lastShift[lastShift.length - 1];
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

  statusEl.textContent = 'Mesai devam ediyor';
  iconEl.innerHTML = '<i class="fas fa-play-circle" style="color: #22c55e;"></i>';
  
  timerInterval = setInterval(() => {
    const startTime = new Date(shift.startTime);
    const now = new Date();
    const elapsedSeconds = (now.getTime() - startTime.getTime()) / 1000;
    timerEl.textContent = formatDuration(elapsedSeconds);

    if (elapsedSeconds >= 43200 && !twelveHourNotified) { // 12 saat
      twelveHourNotified = true;
      sendNotification('⚠️ 12 Saat Uyarısı', 'Mesainiz 12 saattir devam ediyor. Lütfen Mesai Barkodu\'nu okutarak mesainizi sonlandırınız.');
      showToast('⚠️ 12 saat mesai uyarısı gönderildi.', 'warning');
    }

    if (elapsedSeconds >= 46800) { // 13 saat
      autoEndShiftFromFrontend();
    }
  }, 1000);
}

// ================= OTOMATİK SONLANDIRMA (13 Saat) =================
let autoEndTriggered = false;
async function autoEndShiftFromFrontend() {
  if (autoEndTriggered) return;
  autoEndTriggered = true;
  clearInterval(timerInterval);

  try {
    const res = await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST',
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
      localStorage.removeItem(CURRENT_SHIFT_KEY);
      updateAttendanceUI();
    }
  } catch (e) {
    console.error('Otomatik sonlandırma hatası:', e);
    showToast("Otomatik sonlandırma sırasında ağ hatası oluştu. Sistem sunucu tarafında kontrol edecektir.", "error");
    autoEndTriggered = false;
    updateAttendanceUI();
  }
}

// ================= RAPORLAMA =================
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

// ================= YARDIMCI FONKSİYONLAR =================
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ================= ÇIKIŞ =================
document.getElementById('logoutBtn').addEventListener('click', () => {
  showModal("Çıkış Yap", "Oturumu kapatmak istediğinize emin misiniz?", "warning", () => {
    stopScanner(); clearInterval(timerInterval);
    if (locationManager) locationManager.stopWatching();
    localStorage.removeItem('karakus_user');
    location.reload();
  });
});

// Başlangıç listener
initNetworkListeners();
