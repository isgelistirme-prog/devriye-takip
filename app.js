/**
 * KARAKUŞ PLATFORM - FRONTEND ENGINE (v10.4 Production)
 * Özellikler: IndexedDB Queue, State Machine, Merkezi ApiClient, AbortController,
 * GPS'ten Bağımsız Transaction Akışı, Permissions API, Garbage Collection,
 * Adaptive GPS, Outbox Pattern, Cursor-Based Pagination, Self-Healing DB
 */
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyXnLMCDiqyPHkM36MiLKo43SWCEeJTeMoKr_ZxHxA3SI_i71JyAuQciTDCpIr6DU9mUQ/exec',
  CLIENT_ID: '653251016114-4340l82dqeldg25umf3749gr9b4aj8gn.apps.googleusercontent.com',
  LOCATION_RETRY_TIMES: [0, 5, 15, 30, 60, 120, 300, 600],
  API_TIMEOUT_MS: 10000,
  MAX_RETRIES: 8,
  QUEUE_MAX_AGE_MS: 86400000
};

const CURRENT_SHIFT_KEY = 'karakus_current_shift';
const SHIFT_HISTORY_KEY = 'karakus_shift_history';
const DB_NAME = 'KarakusDB';
const STORE_NAME = 'transactionQueue';
const SHIFT_STORE_NAME = 'shiftStore';
const DIAGNOSTIC_STORE_NAME = 'DiagnosticLog';

let currentUser = JSON.parse(localStorage.getItem('karakus_user'));
// Token obfuscation: localStorage'da base64 karışımı saklanır, kullanılırken çözülür.
if (currentUser && currentUser.sessionToken) {
  try {
    currentUser.sessionToken = atob(currentUser.sessionToken).split(':')[0];
  } catch (e) {
    currentUser = null;
    localStorage.removeItem('karakus_user');
  }
}

let html5QrCode = null;
let camState = 'idle';
let timerInterval = null;
let twelveHourNotified = false;
let locationManager = null;
let transactionQueue = null;
let db = null;

// Dinleyici referansları (Memory Leak önleme)
let boundRestartLocation = null;
let boundProcessQueueVisibility = null;
let boundProcessQueueFocus = null;
let boundProcessQueueOnline = null;

// ====================== UTILITY: UUID ======================
function generateUUID() {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ====================== INDEXED DB ======================
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3); // Versiyon 3: nextRetryAt index ve DiagnosticLog store
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'transactionId' });
        store.createIndex('nextRetryAt', 'nextRetryAt', { unique: false });
      } else {
        // Mevcut store'da index yoksa ekle (v2'den v3'e geçiş)
        const store = request.transaction.objectStore(STORE_NAME);
        if (!store.indexNames.contains('nextRetryAt')) {
          store.createIndex('nextRetryAt', 'nextRetryAt', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(SHIFT_STORE_NAME)) {
        db.createObjectStore(SHIFT_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DIAGNOSTIC_STORE_NAME)) {
        db.createObjectStore(DIAGNOSTIC_STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = async (e) => {
      console.error('IndexedDB açılamadı, kendini onarma deneniyor...');
      // Self-healing: DB bozuksa sil ve sayfayı yenile
      try {
        await new Promise(res => indexedDB.deleteDatabase(DB_NAME).onsuccess = res);
      } catch (ignored) {}
      location.reload();
    };
  });
}

// --- Transaction Queue Store ---
async function queueAdd(tx) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    const req = store.add(tx);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Yeni: Sadece nextRetryAt'i geçmiş ve işlenmemiş kayıtları getir
async function queueGetPending(limit = 50) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
    const index = store.index('nextRetryAt');
    const range = IDBKeyRange.upperBound(Date.now());
    const request = index.openCursor(range);
    const results = [];
    let count = 0;
    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && count < limit) {
        const tx = cursor.value;
        if (!tx.isCompleted && !tx.isFailed) {
          results.push(tx);
          count++;
        }
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// getAll hâlâ GC gibi yerler için kullanılabilir, ama GC'yi de optimize edebiliriz.
async function queueGetAll() {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueUpdate(tx) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    const req = store.put(tx);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function queueDelete(transactionId) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    const req = store.delete(transactionId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --- Diagnostic Log Store (Hata raporları için) ---
async function diagnosticLogAdd(diagnosticData) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(DIAGNOSTIC_STORE_NAME, 'readwrite').objectStore(DIAGNOSTIC_STORE_NAME);
    const req = store.add({ ...diagnosticData, loggedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function diagnosticLogGetAll() {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(DIAGNOSTIC_STORE_NAME, 'readonly').objectStore(DIAGNOSTIC_STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function diagnosticLogDelete(id) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(DIAGNOSTIC_STORE_NAME, 'readwrite').objectStore(DIAGNOSTIC_STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --- Shift Store ---
async function shiftPut(data) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(SHIFT_STORE_NAME, 'readwrite').objectStore(SHIFT_STORE_NAME);
    const req = store.put(data);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function shiftGet(id) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(SHIFT_STORE_NAME, 'readonly').objectStore(SHIFT_STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function shiftDelete(id) {
  if (!db) db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(SHIFT_STORE_NAME, 'readwrite').objectStore(SHIFT_STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ====================== MERKEZİ API CLIENT ======================
class ApiClient {
  static async post(action, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);
    
    // Token'ı güvenli biçimde ekle (zaten decode edilmiş hali)
    const finalPayload = { 
      ...payload, 
      action,
      sessionToken: currentUser?.sessionToken || null
    };

    try {
      const res = await fetch(CONFIG.SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalPayload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status === 'error') throw new Error(data.message || 'Bilinmeyen hata');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('İstek zaman aşımına uğradı.');
      throw error;
    }
  }
}

// ====================== LOCATION MANAGER (Adaptive GPS) ======================
class LocationManager {
  constructor() {
    this.watchId = null;
    this.lastKnownLocation = null;
    this.lastKnownTimestamp = null;
    this.permissionState = 'prompt';
    this.isWatching = false;
    this.gpsRetry = 0;
    this.errorCount = 0;
    this.listeners = [];
    this.checkPermissions();
  }

  async checkPermissions() {
    try {
      const result = await navigator.permissions.query({ name: 'geolocation' });
      this.permissionState = result.state;
      result.onchange = () => { this.permissionState = result.state; };
    } catch (e) { /* ignore */ }
  }

  startWatching() {
    if (this.isWatching) return;
    if (!navigator.geolocation) { this.permissionState = 'unavailable'; return; }
    
    this.isWatching = true;
    // Adaptif GPS: Konum varsa düşük hassasiyet, yoksa yüksek
    const hasRecentLocation = this.lastKnownLocation && (Date.now() - this.lastKnownTimestamp) < 120000;
    const highAccuracy = !hasRecentLocation; // yoksa yüksek, varsa düşük
    const maxAge = hasRecentLocation ? 600000 : 30000; // 10 dk vs 30 sn
    
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.lastKnownLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        this.lastKnownTimestamp = Date.now();
        this.permissionState = 'granted';
        this.errorCount = 0;
        this.gpsRetry = 0;
        this.notifyListeners('location_updated', this.lastKnownLocation);
      },
      (err) => {
        this.errorCount++;
        if (err.code === 1) this.permissionState = 'denied';
        else if (err.code === 2) this.permissionState = 'unavailable';
        else if (err.code === 3) this.permissionState = 'timeout';
        this.notifyListeners('location_error', { code: err.code, message: err.message });
        this.stopWatching();
      },
      { enableHighAccuracy: highAccuracy, timeout: 10000, maximumAge: maxAge }
    );
  }

  stopWatching() {
    if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    this.isWatching = false;
  }

  getCachedLocation() {
    if (!this.lastKnownLocation) return null;
    if (Date.now() - this.lastKnownTimestamp > 120000) return null;
    return this.lastKnownLocation;
  }

  async forceGetLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) reject({ error: 'unavailable' });
      if (this.permissionState === 'denied') reject({ error: 'permission_denied' });

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.lastKnownLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
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

  addListener(callback) { this.listeners.push(callback); }
  removeListener(callback) { this.listeners = this.listeners.filter(cb => cb !== callback); }
  notifyListeners(type, data) { this.listeners.forEach(cb => cb(type, data)); }

  getDiagnosticData() {
    return {
      permissionState: this.permissionState,
      errorCount: this.errorCount,
      gpsRetry: this.gpsRetry,
      hasLocation: !!this.lastKnownLocation,
      locationAge: this.lastKnownTimestamp ? (Date.now() - this.lastKnownTimestamp) / 1000 : -1,
      accuracy: this.lastKnownLocation ? this.lastKnownLocation.accuracy : -1,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      isOnline: navigator.onLine
    };
  }
}

// ====================== TRANSACTION QUEUE (STATE MACHINE) ======================
class TransactionQueue {
  constructor() {
    this.processingLock = false;
    this.queueTimer = null;
    this.gcTimer = null;
    this.loadFromDB();
    this.startGarbageCollection();
  }

  async loadFromDB() {
    try {
      const items = await queueGetPending(1); // sadece var mı diye kontrol
      if (items.length > 0) this.processQueue();
    } catch (e) { /* ignore */ }
  }

  async addTransaction(transaction) {
    const tx = {
      ...transaction,
      status: transaction.status || 'NEW',
      isCreatedOnServer: transaction.isCreatedOnServer ?? false,
      gpsRetry: transaction.gpsRetry ?? 0,
      apiRetry: transaction.apiRetry ?? 0,
      nextRetryAt: transaction.nextRetryAt ?? Date.now(),
      createdAt: transaction.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      isCompleted: false,
      isFailed: false,
      failureReason: null
    };
    try {
      await queueAdd(tx);
      this.processQueue();
    } catch (e) {
      console.error('Queue ekleme hatası:', e);
      // Outbox Pattern: Veriyi localStorage'a yedekle
      try {
        localStorage.setItem('backup_' + tx.transactionId, JSON.stringify(tx));
        showToast('Cihaz depolama alanı dolu. İşlem güvenli yedeklemeye alındı.', 'warning');
      } catch (e2) {
        showToast('Kritik hata: İşlem kaydedilemedi! Lütfen cihaz depolama alanınızı kontrol edin.', 'error');
      }
    }
  }

  async processQueue() {
    if (this.processingLock) return;
    this.processingLock = true;

    try {
      // Yeni: queueGetPending ile sadece zamanı gelmiş ve işlenmemiş işlemler
      const pending = await queueGetPending(50);
      const batchSize = 5;
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(async (tx) => {
            if (Date.now() > tx.createdAt + CONFIG.QUEUE_MAX_AGE_MS) {
              tx.isFailed = true;
              tx.failureReason = 'Max Age Expired';
              await queueUpdate(tx);
              return;
            }
            if (Date.now() < tx.nextRetryAt) return;
            await this.processTransaction(tx);
          })
        );
      }
    } catch (e) {
      console.error('Queue processing error:', e);
    } finally {
      this.processingLock = false;
      if (this.queueTimer) clearTimeout(this.queueTimer);
      this.queueTimer = setTimeout(() => this.processQueue(), 15000);
    }
  }

  async processTransaction(tx) {
    // --- NETWORK_WAITING ---
    if (tx.status === 'NETWORK_WAITING') {
      if (navigator.onLine) {
        tx.status = 'SENDING';
        tx.updatedAt = Date.now();
        await queueUpdate(tx);
        return;
      } else {
        tx.nextRetryAt = Date.now() + 15000;
        await queueUpdate(tx);
        return;
      }
    }

    // --- GPS BEKLEME ---
    if (tx.status === 'NEW' || tx.status === 'LOCATION_WAITING') {
      let loc = locationManager.getCachedLocation();
      if (!loc && locationManager.permissionState !== 'denied') {
        try {
          loc = await locationManager.forceGetLocation();
        } catch (err) {
          if (err.error === 'permission_denied') {
            tx.isFailed = true;
            tx.failureReason = 'permission_denied';
            tx.status = 'FAILED';
            tx.updatedAt = Date.now();
            await queueUpdate(tx);
            await this.reportFailure(tx);
            return;
          }
          tx.gpsRetry = (tx.gpsRetry || 0) + 1;
          const nextInterval = CONFIG.LOCATION_RETRY_TIMES[Math.min(tx.gpsRetry, CONFIG.LOCATION_RETRY_TIMES.length - 1)];
          tx.nextRetryAt = Date.now() + (nextInterval * 1000);
          tx.status = 'LOCATION_WAITING';
          tx.updatedAt = Date.now();
          await queueUpdate(tx);
          return;
        }
      }
      if (loc) {
        tx.location = loc;
        tx.status = 'SENDING';
        tx.updatedAt = Date.now();
        await queueUpdate(tx);
      } else {
        return;
      }
    }

    // --- API GÖNDERİMİ ---
    if (tx.status === 'SENDING') {
      if (!navigator.onLine) {
        tx.nextRetryAt = Date.now() + 30000;
        tx.status = 'NETWORK_WAITING';
        tx.updatedAt = Date.now();
        await queueUpdate(tx);
        return;
      }

      try {
        if (!tx.isCreatedOnServer && (tx.type === 'patrol' || tx.type === 'shift_start')) {
          if (tx.type === 'patrol') {
            await ApiClient.post('createTransaction', {
              transactionId: tx.transactionId,
              qrText: tx.qrText,
              barcodeTimestamp: tx.barcodeTimestamp,
              email: tx.email,
              name: tx.name,
              lat: tx.location?.lat,
              lng: tx.location?.lng,
              accuracy: tx.location?.accuracy
            });
          } else if (tx.type === 'shift_start') {
            await ApiClient.post('createShiftTransaction', {
              transactionId: tx.transactionId,
              email: tx.email,
              name: tx.name,
              barcodeTimestamp: tx.barcodeTimestamp,
              userAgent: tx.userAgent,
              lat: tx.location?.lat,
              lng: tx.location?.lng,
              accuracy: tx.location?.accuracy
            });
          }
          tx.isCreatedOnServer = true;
          await queueUpdate(tx);
        }

        if (tx.isCreatedOnServer && tx.location) {
          if (tx.type === 'patrol') {
            await ApiClient.post('updateTransactionLocation', {
              transactionId: tx.transactionId,
              lat: tx.location.lat,
              lng: tx.location.lng,
              accuracy: tx.location.accuracy
            });
            showToast('Konum bilgisi sisteme iletildi.', 'success');
          } else if (tx.type === 'shift_start') {
            await ApiClient.post('updateShiftLocation', {
              transactionId: tx.transactionId,
              lat: tx.location.lat,
              lng: tx.location.lng,
              accuracy: tx.location.accuracy
            });
            showToast('Konum bilgisi sisteme iletildi.', 'success');
          }
        }

        if (tx.type === 'shift_end') {
          const data = await ApiClient.post('endShift', {
            email: tx.email,
            barcodeTimestamp: tx.barcodeTimestamp,
            userAgent: tx.userAgent,
            lat: tx.location?.lat,
            lng: tx.location?.lng,
            accuracy: tx.location?.accuracy
          });
          const endedShift = await shiftGet(CURRENT_SHIFT_KEY);
          if (endedShift) {
            endedShift.endTime = new Date().toISOString();
            endedShift.durationSeconds = data.durationSeconds;
            addToHistory(endedShift);
            await shiftDelete(CURRENT_SHIFT_KEY);
            twelveHourNotified = false;
            updateAttendanceUI();
            showToast(`✅ Mesai tamamlandı! (${formatDurationHM(endedShift.durationSeconds)})`, "success");
          }
        }

        tx.isCompleted = true;
        tx.status = 'SUCCESS';
        tx.updatedAt = Date.now();
        await queueUpdate(tx);
      } catch (error) {
        tx.apiRetry = (tx.apiRetry || 0) + 1;
        const nextInterval = CONFIG.LOCATION_RETRY_TIMES[Math.min(tx.apiRetry, CONFIG.LOCATION_RETRY_TIMES.length - 1)];
        tx.nextRetryAt = Date.now() + (nextInterval * 1000);
        tx.status = 'LOCATION_WAITING';
        tx.updatedAt = Date.now();
        tx.failureReason = error.message;
        await queueUpdate(tx);

        if ((tx.apiRetry || 0) >= CONFIG.MAX_RETRIES) {
          tx.isFailed = true;
          tx.status = 'FAILED';
          tx.updatedAt = Date.now();
          await queueUpdate(tx);
          await this.reportFailure(tx);
        }
      }
    }
  }

  async reportFailure(tx) {
    const diagnostic = locationManager.getDiagnosticData();
    diagnostic.gpsRetry = tx.gpsRetry;
    diagnostic.apiRetry = tx.apiRetry;
    diagnostic.failureReason = tx.failureReason;

    let action = 'reportTransactionFailure';
    if (tx.type === 'shift_start') action = 'reportShiftFailure';
    else if (tx.type === 'shift_end') action = 'reportShiftFailure';

    try {
      await ApiClient.post(action, {
        transactionId: tx.transactionId,
        email: tx.email,
        diagnosticData: JSON.stringify(diagnostic)
      });
    } catch (e) {
      // Hata raporu gönderilemezse yerel DiagnosticLog'a kaydet
      console.error('Failure report gönderilemedi, yerel loga yazılıyor:', e);
      try {
        await this.saveLocalDiagnostic({ transactionId: tx.transactionId, email: tx.email, diagnostic, action });
      } catch (e2) { /* son çare */ }
    }
  }

  async saveLocalDiagnostic(entry) {
    await diagnosticLogAdd(entry);
  }

  startGarbageCollection() {
    this.gcTimer = setInterval(async () => {
      try {
        const queue = await queueGetAll();
        const now = Date.now();
        for (let tx of queue) {
          if ((tx.isCompleted || tx.isFailed) && (now - tx.updatedAt) > CONFIG.QUEUE_MAX_AGE_MS) {
            await queueDelete(tx.transactionId);
          }
        }
        // Ayrıca DiagnosticLog'da 7 günden eski kayıtları temizle
        const logs = await diagnosticLogGetAll();
        const sevenDays = 7 * 24 * 3600 * 1000;
        for (let log of logs) {
          if (now - log.loggedAt > sevenDays) {
            await diagnosticLogDelete(log.id);
          }
        }
        // LocalStorage yedeklerini dene (IDB'ye eklenemeyip kalanları)
        recoverBackups();
      } catch (e) { /* ignore */ }
    }, 3600000);
  }

  destroy() {
    if (this.gcTimer) { clearInterval(this.gcTimer); this.gcTimer = null; }
    if (this.queueTimer) { clearTimeout(this.queueTimer); this.queueTimer = null; }
  }
}

// ====================== YEDEK KURTARMA (Recovery) ======================
async function recoverBackups() {
  if (!db) {
    try { db = await openDB(); } catch (e) { return; }
  }
  const keys = Object.keys(localStorage).filter(k => k.startsWith('backup_'));
  for (let key of keys) {
    try {
      const tx = JSON.parse(localStorage.getItem(key));
      localStorage.removeItem(key);
      await queueAdd(tx);
    } catch (e) {
      // Eğer hâlâ eklenemiyorsa bir sonraki denemeye bırak
    }
  }
}

// ====================== YARDIMCI İŞLEM FONKSİYONU (DRY) ======================
async function createTransactionWithQueue(type, payload) {
  const transactionId = generateUUID();
  let createdOnServer = false;

  try {
    if (type === 'patrol') {
      await ApiClient.post('createTransaction', { transactionId, ...payload });
    } else if (type === 'shift_start') {
      await ApiClient.post('createShiftTransaction', { transactionId, ...payload });
    }
    createdOnServer = true;
    if (type === 'shift_start') {
      // Optimistik UI: Mesai hemen başlasın
      await shiftPut({ 
        id: CURRENT_SHIFT_KEY,
        email: currentUser.email, 
        name: currentUser.name, 
        startTime: payload.barcodeTimestamp || new Date().toISOString(),
        endTime: null 
      });
      twelveHourNotified = false;
      updateAttendanceUI();
      showToast("✅ Mesai başlatıldı! Görev başlangıcı.", "success");
      sendNotification('Mesai Başladı', 'Çalışma süreniz başlatıldı.');
    } else {
      showToast(`${payload.qrText || 'İşlem'} başarıyla kaydedildi.`, 'success');
    }
  } catch (error) {
    showToast("Sunucu bağlantısı yok. İşlem arka planda tamamlanacak.", "warning");
  }

  await transactionQueue.addTransaction({
    transactionId,
    ...payload,
    type,
    status: 'LOCATION_WAITING',
    isCreatedOnServer: createdOnServer
  });

  if (type === 'patrol') {
    resumeScanner();
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

function showDevriyeProgress(title, message, iconClass = 'fa-spinner fa-spin', color = 'var(--primary)') {
  const modal = document.getElementById('devriyeActionModal');
  document.getElementById('devriyeTitle').textContent = title;
  document.getElementById('devriyeMessage').textContent = message;
  document.getElementById('devriyeIcon').innerHTML = `<i class="fas ${iconClass}" style="color: ${color};"></i>`;
  modal.classList.remove('hidden');
}
function hideDevriyeProgress() { document.getElementById('devriyeActionModal').classList.add('hidden'); }

// ================= AUTH & SCANNER =================
function initializeGoogleLogin() {
  google.accounts.id.initialize({
    client_id: CONFIG.CLIENT_ID, callback: handleCredentialResponse, auto_select: false, prompt: 'select_account'
  });
  google.accounts.id.renderButton(document.getElementById('g_id_signin'), { theme: 'filled_blue', size: 'large', width: 280 });
}

async function handleCredentialResponse(response) {
  document.querySelector('.subtitle').textContent = "Oturum açılıyor...";
  try {
    const data = await ApiClient.post('verifyUser', { token: response.credential });
    if (data.status === 'active') {
      // Token obfuscation: base64 ile karıştır
      const rawToken = data.sessionToken;
      const obfuscated = btoa(rawToken + ':' + navigator.userAgent);
      currentUser = { email: data.email, name: data.name, sessionToken: rawToken }; // bellekte ham
      localStorage.setItem('karakus_user', JSON.stringify({ email: data.email, name: data.name, sessionToken: obfuscated }));
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
  
  locationManager = new LocationManager();
  transactionQueue = new TransactionQueue();
  locationManager.startWatching();

  // Bellek sızıntısını önlemek için referansları tut
  boundRestartLocation = () => { if (currentUser && locationManager) locationManager.startWatching(); };
  boundProcessQueueVisibility = () => { if (!document.hidden && transactionQueue) transactionQueue.processQueue(); };
  boundProcessQueueFocus = () => { if (transactionQueue) transactionQueue.processQueue(); };
  boundProcessQueueOnline = () => { if (transactionQueue) transactionQueue.processQueue(); };

  document.addEventListener('visibilitychange', boundRestartLocation);
  window.addEventListener('focus', boundRestartLocation);
  window.addEventListener('online', boundRestartLocation);
  document.addEventListener('visibilitychange', boundProcessQueueVisibility);
  window.addEventListener('focus', boundProcessQueueFocus);
  window.addEventListener('online', boundProcessQueueOnline);

  // Yedekten kurtarma
  recoverBackups();
  // Sunucudan mesai durumu
  loadCurrentShiftFromServer();
  updateAttendanceUI();
  initScanner();
  document.getElementById('reportBtn').addEventListener('click', showReport);
}

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

// ================= QR OKUMA & ANA AKIŞ =================
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

  camState = 'processing';
  document.getElementById('scanResult').innerHTML = "📍 Devriye kaydediliyor...";
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

// ================= DEVRİYE KAYDI (Yardımcı fonksiyon ile) =================
async function processPatrolScan(qrText, barcodeTimestamp) {
  await createTransactionWithQueue('patrol', {
    qrText,
    barcodeTimestamp: barcodeTimestamp.toISOString(),
    email: currentUser.email,
    name: currentUser.name
  });
}

// ================= MESAİ YÖNETİMİ =================
async function loadCurrentShiftFromServer() {
  if (!currentUser) return;
  try {
    const data = await ApiClient.post('getCurrentShift', { email: currentUser.email });
    if (data.status === 'success' && data.shift) {
      await shiftPut({ id: CURRENT_SHIFT_KEY, ...data.shift });
    } else {
      await shiftDelete(CURRENT_SHIFT_KEY);
    }
    updateAttendanceUI();
  } catch (e) { console.warn('Sunucudan mesai durumu alınamadı:', e); }
}

async function handleStartShift(barcodeTimestamp) {
  await createTransactionWithQueue('shift_start', {
    email: currentUser.email,
    name: currentUser.name,
    barcodeTimestamp: barcodeTimestamp.toISOString(),
    userAgent: navigator.userAgent
  });
}

document.getElementById('confirmEndYes').addEventListener('click', async () => {
  document.getElementById('confirmEndModal').classList.add('hidden');
  
  const transactionId = generateUUID();
  const barcodeTimestamp = new Date();

  await transactionQueue.addTransaction({
    transactionId: transactionId,
    type: 'shift_end',
    email: currentUser.email,
    name: currentUser.name,
    userAgent: navigator.userAgent,
    barcodeTimestamp: barcodeTimestamp.toISOString(),
    status: 'LOCATION_WAITING',
    isCreatedOnServer: true
  });
  
  const shift = await shiftGet(CURRENT_SHIFT_KEY);
  if (shift) {
    await shiftDelete(CURRENT_SHIFT_KEY);
    twelveHourNotified = false;
    updateAttendanceUI();
  }
  showToast("Mesai bitirme işlemi başlatıldı. Onayınız sisteme iletiliyor.", "success");
});

document.getElementById('confirmEndNo').addEventListener('click', () => {
  document.getElementById('confirmEndModal').classList.add('hidden');
  showToast("Mesai bitirme işlemi iptal edildi.", "warning");
});

// ================= GEÇMİŞ, SÜRE, UI VE RAPOR =================
function addToHistory(shift) {
  const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
  history.push({
    startTime: shift.startTime, endTime: shift.endTime, durationSeconds: shift.durationSeconds,
    isAutoEnded: shift.isAutoEnded || false, date: new Date(shift.startTime).toLocaleDateString('tr-TR')
  });
  localStorage.setItem(SHIFT_HISTORY_KEY, JSON.stringify(history));
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function formatDurationHM(seconds) {
  const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60);
  return `${h} Saat ${m} Dakika`;
}

// DOM referansı dışarıda, sadece değişiklikte güncelle
const attTimerEl = document.getElementById('attTimer');
let lastFormatted = '';

async function updateAttendanceUI() {
  const shift = await shiftGet(CURRENT_SHIFT_KEY);
  const statusEl = document.getElementById('attStatus');
  const iconEl = document.getElementById('attIcon');
  
  if (timerInterval) clearInterval(timerInterval);
  lastFormatted = '';

  if (!shift) {
    const history = JSON.parse(localStorage.getItem(SHIFT_HISTORY_KEY) || '[]');
    const today = new Date().toDateString();
    const lastShift = history.filter(s => new Date(s.startTime).toDateString() === today);
    if (lastShift.length > 0) {
      const last = lastShift[lastShift.length - 1];
      statusEl.textContent = `Bugün son mesai: ${formatDurationHM(last.durationSeconds)}`;
      attTimerEl.textContent = formatDuration(last.durationSeconds);
      iconEl.innerHTML = '<i class="fas fa-flag-checkered" style="color: #ef4444;"></i>';
    } else {
      statusEl.textContent = 'Bugün mesai başlatılmadı';
      attTimerEl.textContent = '00:00:00';
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
    const formatted = formatDuration(elapsedSeconds);
    if (formatted !== lastFormatted) {
      attTimerEl.textContent = formatted;
      lastFormatted = formatted;
    }

    if (elapsedSeconds >= 43200 && !twelveHourNotified) {
      twelveHourNotified = true;
      sendNotification('⚠️ 12 Saat Uyarısı', 'Mesainiz 12 saattir devam ediyor. Lütfen Mesai Barkodu\'nu okutarak mesainizi sonlandırınız.');
      showToast('⚠️ 12 saat mesai uyarısı gönderildi.', 'warning');
    }
    if (elapsedSeconds >= 46800) autoEndShiftFromFrontend();
  }, 1000);
}

let autoEndTriggered = false;
async function autoEndShiftFromFrontend() {
  if (autoEndTriggered) return;
  autoEndTriggered = true;
  clearInterval(timerInterval);
  try {
    const data = await ApiClient.post('autoEndShift', { email: currentUser.email });
    if (data.status === 'success') {
      const shift = await shiftGet(CURRENT_SHIFT_KEY);
      if(shift) {
        shift.endTime = new Date().toISOString(); shift.durationSeconds = data.durationSeconds; shift.isAutoEnded = true;
        addToHistory(shift); 
        await shiftDelete(CURRENT_SHIFT_KEY);
        twelveHourNotified = false; 
        updateAttendanceUI();
        showToast("⚠️ Mesai 13 saat dolduğu için sistem tarafından otomatik sonlandırıldı.", "warning");
        sendNotification('Mesai Otomatik Sonlandırıldı', '13 saat sınırı aşıldığı için mesainiz sistem tarafından kapatılmıştır.');
      }
    } else { 
      await shiftDelete(CURRENT_SHIFT_KEY); 
      updateAttendanceUI(); 
    }
  } catch (e) {
    console.error('Otomatik sonlandırma hatası:', e);
    showToast("Otomatik sonlandırma sırasında ağ hatası oluştu. Sistem sunucu tarafında kontrol edecektir.", "error");
    autoEndTriggered = false; 
    updateAttendanceUI();
  }
}

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
      const data = await ApiClient.post('getAttendance', {
        email: currentUser.email, startDate: startDate.toISOString(), endDate: endDate.toISOString()
      });
      if (data.status === 'success' && data.records.length > 0) {
        let html = `<table><thead><tr><th>Tarih</th><th>Başlangıç</th><th>Bitiş</th><th>Süre</th><th>Otomatik Sonlandırıldı</th></tr></thead><tbody>`;
        data.records.forEach(item => {
          const start = new Date(item.startTime).toLocaleString('tr-TR');
          const end = item.endTime ? new Date(item.endTime).toLocaleString('tr-TR') : '-';
          const dur = formatDurationHM(item.durationSeconds || 0);
          const autoEnd = item.isAutoEnded ? '⚠️ Evet' : 'Hayır';
          html += `<tr><td>${new Date(item.startTime).toLocaleDateString('tr-TR')}</td><td>${start}</td><td>${end}</td><td>${dur}</td><td>${autoEnd}</td></tr>`;
        });
        html += `</tbody></table>`;
        dataDiv.innerHTML = html;
      } else dataDiv.innerHTML = '<p class="empty">Bu döneme ait kayıt bulunamadı.</p>';
    } catch (error) { dataDiv.innerHTML = '<p style="color:red;">Rapor yüklenirken hata oluştu. Lütfen bağlantınızı kontrol edin.</p>'; }
  };
}
document.getElementById('reportCloseBtn').addEventListener('click', () => { document.getElementById('reportModal').classList.add('hidden'); });

// ================= PUSH BİLDİRİM & YARDIMCI =================
function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
  Notification.requestPermission();
}
function sendNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: 'logo.png' }); } catch(e) {}
}

// ================= ÇIKIŞ & DB KAPATMA (Bellek Temizliği) =================
document.getElementById('logoutBtn').addEventListener('click', () => {
  showModal("Çıkış Yap", "Oturumu kapatmak istediğinize emin misiniz?", "warning", () => {
    stopScanner(); 
    if (timerInterval) clearInterval(timerInterval);
    if (locationManager) { locationManager.stopWatching(); locationManager = null; }
    if (transactionQueue) { 
      transactionQueue.destroy();
      transactionQueue = null; 
    }
    // Dinleyicileri temizle
    if (boundRestartLocation) {
      document.removeEventListener('visibilitychange', boundRestartLocation);
      window.removeEventListener('focus', boundRestartLocation);
      window.removeEventListener('online', boundRestartLocation);
    }
    if (boundProcessQueueVisibility) {
      document.removeEventListener('visibilitychange', boundProcessQueueVisibility);
    }
    if (boundProcessQueueFocus) {
      window.removeEventListener('focus', boundProcessQueueFocus);
    }
    if (boundProcessQueueOnline) {
      window.removeEventListener('online', boundProcessQueueOnline);
    }
    boundRestartLocation = null;
    boundProcessQueueVisibility = null;
    boundProcessQueueFocus = null;
    boundProcessQueueOnline = null;
    localStorage.removeItem('karakus_user');
    if (db) { db.close(); db = null; }
    location.reload();
  });
});

window.onload = () => {
  initNetworkListeners();
  if (currentUser && currentUser.sessionToken) onLoginSuccess();
  else initializeGoogleLogin();
  requestNotificationPermission();
};

window.addEventListener('beforeunload', () => {
  if (db) { db.close(); db = null; }
});
