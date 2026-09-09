// Listen Mode - Content Script
// This script runs on YouTube pages and enables audio-only playback

if (!window.__youtubeAudioModeLoaded) {
    window.__youtubeAudioModeLoaded = true;

    // ===== CONFIGURATION CONSTANTS =====
    const TIMING = {
        RETRY_DELAY: 1000,
        QUALITY_SET_DELAY: 1000,
        QUALITY_CHECK_INTERVAL: 5000,
        USAGE_TRACKING_INTERVAL: 5000,
        FALLBACK_TIMEOUT: 3000,
        UI_INTERACTION_BASE: 300,
        UI_INTERACTION_STEP: 100,
        UI_INTERACTION_FINAL: 200,
        API_VERIFICATION_DELAY: 500,
        LOCK_DURATION: 7000 // 7 seconds grace period for programmatic changes
    };

    const QUALITY = {
        TARGET: 'tiny',  // 144p
        FALLBACK: 'small',
        RESTORE: 'hd720' // 720p (default, overridden by user setting)
    };

    // YouTube API quality level -> player settings menu text
    const QUALITY_UI_TEXT = {
        'auto': 'Auto',
        'tiny': '144p',
        'small': '240p',
        'medium': '360p',
        'large': '480p',
        'hd720': '720p',
        'hd1080': '1080p',
        'hd1440': '1440p',
        'hd2160': '2160p'
    };

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // ===== STATE VARIABLES =====
    let audioModeEnabled = false;
    let audioModeOverlay = null;
    let qualityCheckInterval = null;
    let usageTrackingInterval = null;
    let cachedVideoElement = null;
    let currentLanguage = 'en';
    let videoPlayHandler = null;
    let videoPauseHandler = null;
    let videoTimeUpdateHandler = null;
    let currentPlaybackSpeed = 1;
    let isApplyingSpeed = false;
    let userSetSpeed = false;

    // Bi-directional Sync Variables
    let programmaticQualityLock = 0;
    let userManuallyChangedQuality = false;

    // User-selected quality applied when audio mode is turned off
    let restoreQualityLevel = QUALITY.RESTORE;

    // Last quality reported by the page-context hook (inject.js)
    let lastReportedPageQuality = null;

    // Overlay visual style: bars | vinyl | rings | wave | thumb | minimal
    const OVERLAY_STYLES = ['bars', 'vinyl', 'rings', 'wave', 'thumb', 'minimal'];
    let overlayStyle = 'bars';

    // Utility to lock manual detection during automated changes
    function setProgrammaticLock() {
        programmaticQualityLock = Date.now();
    }

    function isQualityLocked() {
        return (Date.now() - programmaticQualityLock) < TIMING.LOCK_DURATION;
    }

    // Route player API calls through the page-context hook — the content
    // script's isolated world may not see movie_player's API methods in Safari
    function setPageQuality(quality) {
        try {
            window.postMessage({ type: 'AM_SET_QUALITY_REQUEST', quality: quality }, '*');
        } catch (e) { }
    }

    function requestPageQuality() {
        try {
            window.postMessage({ type: 'AM_GET_QUALITY_REQUEST' }, '*');
        } catch (e) { }
    }

    let loadedMessages = {};

    function t(messageName) {
        if (loadedMessages[messageName] && loadedMessages[messageName].message) {
            return loadedMessages[messageName].message;
        }
        return chrome.i18n.getMessage(messageName) || messageName;
    }

    async function loadMessages(lang) {
        try {
            const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
            const response = await fetch(url);
            const messages = await response.json();
            loadedMessages = messages;
            currentLanguage = lang;
            return messages;
        } catch (error) {
            console.error(`Failed to load messages for ${lang}:`, error);
            return null;
        }
    }

    // Safely inject API hook via external file to bypass MV3 CSP
    function injectYouTubeAPIHook() {
        if (document.getElementById('am-yt-api-hook')) return;
        const script = document.createElement('script');
        script.id = 'am-yt-api-hook';
        script.src = chrome.runtime.getURL('inject.js');
        (document.head || document.documentElement).appendChild(script);
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data) return;
        if (event.data.type === 'AM_QUALITY_CHANGE') {
            if (isQualityLocked()) return;
            console.log('[Audio Mode] User manually changed quality to', event.data.quality);
            userManuallyChangedQuality = true;
        } else if (event.data.type === 'AM_QUALITY_STATUS' && event.data.quality) {
            lastReportedPageQuality = event.data.quality;
        }
    });

    if (chrome.runtime?.id) {
        try {
            chrome.storage.sync.get(['audioMode', 'language', 'playbackSpeed', 'userSetSpeed', 'restoreQuality', 'overlayStyle'], async function (result) {
                if (chrome.runtime.lastError) return;

                if (result.restoreQuality) {
                    restoreQualityLevel = result.restoreQuality;
                }
                if (OVERLAY_STYLES.includes(result.overlayStyle)) {
                    overlayStyle = result.overlayStyle;
                }

                if (result.language) {
                    await loadMessages(result.language);
                } else {
                    const detectedLang = chrome.i18n.getUILanguage().startsWith('ar') ? 'ar' : 'en';
                    await loadMessages(detectedLang);
                }

                if (result.audioMode && !audioModeEnabled) enableAudioMode();

                if (result.userSetSpeed !== undefined && result.playbackSpeed) {
                    userSetSpeed = result.userSetSpeed;
                    currentPlaybackSpeed = result.playbackSpeed;
                    applyPlaybackSpeed();
                }
            });
        } catch (error) {
            console.log('[Audio Mode] Error during initialization:', error);
        }
    }

    // Keep restore quality in sync even if the popup's direct message didn't reach us
    if (chrome.runtime?.id && chrome.storage?.onChanged) {
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'sync' && changes.restoreQuality) {
                    restoreQualityLevel = changes.restoreQuality.newValue || QUALITY.RESTORE;
                }
                if (area === 'sync' && changes.overlayStyle) {
                    setOverlayStyle(changes.overlayStyle.newValue);
                }
            });
        } catch (e) { }
    }

    function getVideoElement() {
        if (!cachedVideoElement || !document.contains(cachedVideoElement)) {
            cachedVideoElement = document.querySelector('video');
        }
        return cachedVideoElement;
    }

    function clearVideoCache() {
        cachedVideoElement = null;
    }

    let _broadcastTimer = null;
    function broadcastPlaybackState() {
        if (_broadcastTimer) return;
        _broadcastTimer = setTimeout(() => {
            _broadcastTimer = null;
            if (!chrome.runtime?.id) return;
            const state = getPlaybackState();
            if (!state) return;
            try {
                chrome.runtime.sendMessage({ action: 'playbackStateUpdate', state }).catch(() => { });
            } catch (e) { }
        }, 250);
    }

    let _videoPushListenersAttached = false;
    function attachVideoPushListeners() {
        const video = getVideoElement();
        if (!video || _videoPushListenersAttached) return;
        _videoPushListenersAttached = true;

        const pushEvents = ['play', 'pause', 'seeked', 'volumechange', 'ratechange'];
        pushEvents.forEach(evt => {
            video.addEventListener(evt, broadcastPlaybackState);
        });
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'toggleAudioMode') {
            if (audioModeEnabled) disableAudioMode();
            else enableAudioMode();
            sendResponse({ enabled: audioModeEnabled });
        } else if (request.action === 'setAudioMode') {
            // Idempotent explicit state — safe to call right after injection
            const wanted = !!request.enabled;
            if (wanted && !audioModeEnabled) enableAudioMode();
            else if (!wanted && audioModeEnabled) disableAudioMode();
            sendResponse({ enabled: audioModeEnabled });
        } else if (request.action === 'getStatus') {
            sendResponse({ enabled: audioModeEnabled });
        } else if (request.action === 'updateTheme') {
            updateOverlayTheme(request.backgroundType, request.backgroundValue);
            sendResponse({ success: true });
        } else if (request.action === 'updateLanguage') {
            currentLanguage = request.language;
            updateOverlayLanguage().then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        } else if (request.action === 'setPlaybackSpeed') {
            userSetSpeed = true;
            currentPlaybackSpeed = request.speed;
            applyPlaybackSpeed();
            sendResponse({ success: true });
        } else if (request.action === 'updateRestoreQuality') {
            restoreQualityLevel = request.quality || QUALITY.RESTORE;
            sendResponse({ success: true });
        } else if (request.action === 'updateOverlayStyle') {
            setOverlayStyle(request.style);
            sendResponse({ success: true });
        } else if (request.action === 'getPlaybackState') {
            sendResponse(getPlaybackState());
        } else if (request.action === 'togglePlayback') {
            const video = getVideoElement();
            if (video) video.paused ? video.play() : video.pause();
            sendResponse({ success: true });
        } else if (request.action === 'seek') {
            const video = getVideoElement();
            if (video && request.time !== undefined) video.currentTime = request.time;
            sendResponse({ success: true });
        } else if (request.action === 'seekBy') {
            const video = getVideoElement();
            if (video && request.offset !== undefined) video.currentTime += request.offset;
            sendResponse({ success: true });
        } else if (request.action === 'setVolume') {
            const video = getVideoElement();
            if (video && request.volume !== undefined) {
                video.volume = request.volume;
                if (request.volume > 0 && video.muted) video.muted = false;
            }
            sendResponse({ success: true });
        } else if (request.action === 'getVolume') {
            const video = getVideoElement();
            sendResponse({ volume: video ? video.volume : 1, muted: video ? video.muted : false });
        }
    });

    let enableRetries = 0;
    async function enableAudioMode(isRetry = false) {
        audioModeEnabled = true;
        setProgrammaticLock();

        if (!isRetry) {
            enableRetries = 0;
            userManuallyChangedQuality = false;
            injectYouTubeAPIHook();
        }

        const video = getVideoElement();
        if (!video) {
            if (enableRetries < 10) {
                enableRetries++;
                setTimeout(() => enableAudioMode(true), TIMING.RETRY_DELAY);
            }
            return;
        }
        enableRetries = 0;

        attachVideoPushListeners();
        video.style.opacity = '0';
        await createAudioModeOverlay();

        const setQualityWhenReady = () => {
            if (video.readyState >= 2 && !video.paused) {
                setLowestQuality();
            } else {
                const playListener = () => {
                    setTimeout(() => {
                        setLowestQuality();
                    }, TIMING.QUALITY_SET_DELAY);
                    video.removeEventListener('play', playListener);
                };
                video.addEventListener('play', playListener, { once: true });

                setTimeout(() => {
                    if (audioModeEnabled) setLowestQuality();
                }, TIMING.FALLBACK_TIMEOUT);
            }
        };

        setQualityWhenReady();

        if (chrome.runtime?.id) {
            try { chrome.storage.sync.set({ audioMode: true }); } catch (e) { }
        }
        startUsageTracking();
    }

    function disableAudioMode() {
        audioModeEnabled = false;
        const video = getVideoElement();
        if (video) video.style.opacity = '1';

        restoreQuality();

        const player = document.getElementById('movie_player');
        if (player) delete player.__audioModeQualityAttempted;

        if (video) {
            if (videoPlayHandler) {
                video.removeEventListener('play', videoPlayHandler);
                videoPlayHandler = null;
            }
            if (videoPauseHandler) {
                video.removeEventListener('pause', videoPauseHandler);
                videoPauseHandler = null;
            }
            if (videoTimeUpdateHandler) {
                video.removeEventListener('timeupdate', videoTimeUpdateHandler);
                video.removeEventListener('loadedmetadata', videoTimeUpdateHandler);
                videoTimeUpdateHandler = null;
            }
        }

        if (audioModeOverlay) {
            audioModeOverlay.remove();
            audioModeOverlay = null;
        }

        if (chrome.runtime?.id) {
            try { chrome.storage.sync.set({ audioMode: false }); } catch (e) { }
        }

        if (qualityCheckInterval) {
            clearInterval(qualityCheckInterval);
            qualityCheckInterval = null;
        }
        stopUsageTracking();
    }

    /**
     * UI Clicker: Multilingual & Regex-based
     */
    const clickQualitySetting = async (video, targetText = '144p') => {
        if (userManuallyChangedQuality) return;

        const wasPlaying = !video.paused;
        const currentTime = video.currentTime;

        const settingsPanel = document.querySelector('.ytp-settings-menu');
        const popup = document.querySelector('.ytp-popup');

        const originalPanelStyles = {};
        const originalPopupStyles = {};

        const restoreUI = () => {
            if (settingsPanel) {
                settingsPanel.style.visibility = originalPanelStyles.visibility || '';
                settingsPanel.style.opacity = originalPanelStyles.opacity || '';
                settingsPanel.style.pointerEvents = originalPanelStyles.pointerEvents || '';
            }
            if (popup) {
                popup.style.visibility = originalPopupStyles.visibility || '';
                popup.style.opacity = originalPopupStyles.opacity || '';
                popup.style.pointerEvents = originalPopupStyles.pointerEvents || '';
            }
            setTimeout(() => { programmaticQualityLock = Date.now(); }, 500);

            // Second pass: clear any leftover hiding styles and make sure the
            // menu isn't stuck open (which makes the gear button feel dead)
            setTimeout(() => {
                document.querySelectorAll('.ytp-settings-menu, .ytp-popup').forEach(el => {
                    if (el.style.visibility === 'hidden') el.style.removeProperty('visibility');
                    if (el.style.opacity === '0') el.style.removeProperty('opacity');
                    if (el.style.pointerEvents === 'none') el.style.removeProperty('pointer-events');
                });
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                }));
            }, 400);
        };

        try {
            setProgrammaticLock();

            if (settingsPanel) {
                originalPanelStyles.visibility = settingsPanel.style.visibility;
                originalPanelStyles.opacity = settingsPanel.style.opacity;
                originalPanelStyles.pointerEvents = settingsPanel.style.pointerEvents;
                settingsPanel.style.visibility = 'hidden';
                settingsPanel.style.opacity = '0';
                settingsPanel.style.pointerEvents = 'none';
            }
            if (popup) {
                originalPopupStyles.visibility = popup.style.visibility;
                originalPopupStyles.opacity = popup.style.opacity;
                originalPopupStyles.pointerEvents = popup.style.pointerEvents;
                popup.style.visibility = 'hidden';
                popup.style.opacity = '0';
                popup.style.pointerEvents = 'none';
            }

            const settingsButton = document.querySelector('.ytp-settings-button');
            if (!settingsButton) return;

            settingsButton.click();
            await delay(150);

            // Multilingual detection: Find the menu item based on common strings or regex matching resolutions (e.g. 480p)
            const qualityMenuItem = Array.from(document.querySelectorAll('.ytp-menuitem')).find(item => {
                const text = item.textContent.toLowerCase();
                return text.includes('quality') ||
                    text.includes('الجودة') ||
                    text.includes('calidad') ||
                    text.includes('qualité') ||
                    text.match(/\d{3,4}p/);
            });

            if (qualityMenuItem) {
                qualityMenuItem.click();
                await delay(300);

                const menuItems = Array.from(document.querySelectorAll('.ytp-menuitem'));
                const targetOption = menuItems.find(item => item.textContent.includes(targetText));

                if (targetOption) {
                    setProgrammaticLock();
                    targetOption.click();
                } else {
                    if (targetText === '144p' && menuItems.length > 0) {
                        setProgrammaticLock();
                        // Find the last item that has a 'p' (which is structurally the lowest resolution)
                        const pOptions = menuItems.filter(item => item.textContent.match(/\d{3,4}p/));
                        if (pOptions.length > 0) {
                            pOptions[pOptions.length - 1].click();
                        } else {
                            menuItems[menuItems.length - 1].click();
                        }
                    } else if (targetText !== '144p') {
                        // Restore quality unavailable in the menu — fall back to Auto
                        const autoOption = menuItems.find(item => item.textContent.includes('Auto') || item.textContent.includes('تلقائية'));
                        if (autoOption) {
                            setProgrammaticLock();
                            autoOption.click();
                        }
                    }
                }

                await delay(200);

                const escapeEvent = new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                });
                document.dispatchEvent(escapeEvent);
            }

            // Never seek back to a bogus position — the video element can
            // momentarily report 0 while YouTube swaps the quality stream
            if (wasPlaying && video.paused && isFinite(currentTime) && currentTime > 1) {
                video.currentTime = currentTime;
                video.play().catch(err => console.log('[Audio Mode] Could not resume:', err));
            }

        } catch (error) {
            console.error('[Audio Mode] Error in invisible UI interaction:', error);
        } finally {
            restoreUI();
        }
    };

    const forceLowestQuality = (player, video) => {
        if (userManuallyChangedQuality) return;

        const applyAPI = () => {
            try {
                if (player.setPlaybackQualityRange) player.setPlaybackQualityRange('tiny', 'tiny');
                if (player.setPlaybackQuality) player.setPlaybackQuality('tiny');
                if (typeof player.setInternalQuality === 'function') player.setInternalQuality('tiny');
                if (player.playerInfo && player.playerInfo.setPlaybackQuality) player.playerInfo.setPlaybackQuality('tiny');
            } catch (e) { }
            // Page-context bridge — works even when the isolated world can't see the API
            setPageQuality('tiny');
        }

        try {
            setProgrammaticLock();
            const wasPlaying = !video.paused;
            // The quality switch can restart the stream from 0 — remember where we were
            const safePosition = (isFinite(video.currentTime) && video.currentTime > 1) ? video.currentTime : null;

            // Apply immediately
            applyAPI();

            // Repair the position if the stream switch restarted playback
            if (safePosition !== null) {
                let repairs = 0;
                const repairPosition = () => {
                    if (!audioModeEnabled || !player.isConnected || repairs >= 8) return;
                    repairs++;
                    const now = video.currentTime;
                    if (isFinite(now) && now < safePosition - 5 && !video.seeking) {
                        console.log('[Audio Mode] Position lost (' + now.toFixed(1) + 's) — restoring to ' + safePosition.toFixed(1) + 's');
                        video.currentTime = safePosition;
                        if (wasPlaying && video.paused) video.play().catch(() => { });
                    }
                    setTimeout(repairPosition, 700);
                };
                setTimeout(repairPosition, 700);
            }

            // Aggressively re-apply for 2 seconds to defeat YouTube's startup adaptive engine
            let attempts = 0;
            const aggressiveLock = setInterval(() => {
                if (userManuallyChangedQuality || attempts > 4) {
                    clearInterval(aggressiveLock);
                    return;
                }
                const currentQuality = player.getPlaybackQuality ? player.getPlaybackQuality() : 'unknown';
                if (currentQuality !== 'tiny' && currentQuality !== 'small') {
                    applyAPI();
                }
                attempts++;
            }, 500);

            // Give API 2.5 seconds to settle before attempting the UI click fallback
            setTimeout(() => {
                const currentQuality = player.getPlaybackQuality ? player.getPlaybackQuality() : 'unknown';
                const isFirstAttempt = !player.__audioModeQualityAttempted;

                if (currentQuality !== 'tiny' && currentQuality !== 'small') {
                    if (isFirstAttempt) {
                        player.__audioModeQualityAttempted = true;
                        clickQualitySetting(video, '144p');
                        return;
                    }
                } else {
                    player.__audioModeQualityAttempted = true;
                }

                if (wasPlaying && video.paused) {
                    video.play().catch(err => console.log('[Audio Mode] Could not resume playback:', err));
                }
            }, 2500);

        } catch (error) {
            console.error('[Audio Mode] Error setting quality:', error);
        }
    };

    const restoreQuality = () => {
        const player = document.getElementById('movie_player');
        const video = getVideoElement();

        if (!player || !video) {
            setTimeout(() => {
                const p = document.getElementById('movie_player');
                const v = getVideoElement();
                if (p && v) doRestoreQuality(p, v);
            }, 200);
            return;
        }

        doRestoreQuality(player, video);
    };

    const doRestoreQuality = (player, video) => {
        setProgrammaticLock();
        userManuallyChangedQuality = false;

        // Quality switches can momentarily reset the media element to 0 —
        // never let that become the "restored" position
        const safePosition = (isFinite(video.currentTime) && video.currentTime > 1) ? video.currentTime : null;
        const wasPlaying = !video.paused;

        try {
            const availableLevels = player.getAvailableQualityLevels ? player.getAvailableQualityLevels() : [];
            let target = restoreQualityLevel;
            let uiTargetText = QUALITY_UI_TEXT[restoreQualityLevel] || '720p';

            // Fall back to Auto if the chosen quality isn't offered for this video
            if (target !== 'auto' && availableLevels.length > 0 && !availableLevels.includes(target)) {
                console.log('[Audio Mode] Restore quality', target, 'unavailable, using Auto. Available:', availableLevels.join(','));
                target = 'auto';
                uiTargetText = 'Auto';
            }

            console.log('[Audio Mode] Restoring quality to:', target);

            // Phase 1: page-context API attempts (invisible — never touches the player UI)
            const applyAPI = () => {
                try {
                    if (player.setPlaybackQualityRange) player.setPlaybackQualityRange(target, target);
                    if (player.setPlaybackQuality) player.setPlaybackQuality(target);
                } catch (e) { }
                setPageQuality(target);
            };
            applyAPI();
            setTimeout(applyAPI, 500);
            setTimeout(applyAPI, 1200);

            // Phase 2: single UI fallback only if the API alone didn't achieve it
            setTimeout(() => {
                if (audioModeEnabled || !player.isConnected) return;
                requestPageQuality();
                const current = lastReportedPageQuality ||
                    (player.getPlaybackQuality ? player.getPlaybackQuality() : 'unknown');
                console.log('[Audio Mode] Restore status: current=' + current + ', wanted=' + target);
                if (current !== target) clickQualitySetting(video, uiTargetText);
            }, 2000);

            // Phase 3: repair the position if the stream switch restarted playback
            if (safePosition !== null) {
                let repairs = 0;
                const repairPosition = () => {
                    if (audioModeEnabled || !player.isConnected || repairs >= 8) return;
                    repairs++;
                    const now = video.currentTime;
                    if (isFinite(now) && now < safePosition - 5 && !video.seeking) {
                        console.log('[Audio Mode] Position lost (' + now.toFixed(1) + 's) — restoring to ' + safePosition.toFixed(1) + 's');
                        video.currentTime = safePosition;
                        if (wasPlaying && video.paused) video.play().catch(() => { });
                    }
                    setTimeout(repairPosition, 700);
                };
                setTimeout(repairPosition, 700);
            }
        } catch (e) {
            console.error('[Audio Mode] Error restoring quality:', e);
        }
    };

    let pendingStats = { listened: 0, active: 0 };
    const FLUSH_INTERVAL = 30000;
    const RETENTION_DAYS = 90;

    function pruneOldEntries(obj) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
        const cutoffStr = cutoff.toISOString().split('T')[0];
        for (const key of Object.keys(obj)) {
            if (key < cutoffStr) delete obj[key];
        }
    }

    function flushStatsToStorage() {
        if (pendingStats.listened === 0 && pendingStats.active === 0) return;
        if (!chrome.runtime?.id || !chrome.storage?.local) return;

        const today = new Date().toISOString().split('T')[0];
        const toFlush = { ...pendingStats };
        pendingStats.listened = 0;
        pendingStats.active = 0;

        chrome.storage.local.get(['statsLogs', 'activeLogs'], (result) => {
            if (chrome.runtime.lastError) return;
            const statsLogs = result.statsLogs || {};
            const activeLogs = result.activeLogs || {};

            statsLogs[today] = (statsLogs[today] || 0) + toFlush.listened;
            activeLogs[today] = (activeLogs[today] || 0) + toFlush.active;

            pruneOldEntries(statsLogs);
            pruneOldEntries(activeLogs);

            chrome.storage.local.set({ statsLogs, activeLogs });
        });
    }

    function startUsageTracking() {
        if (usageTrackingInterval) return;

        usageTrackingInterval = setInterval(() => {
            if (!chrome.runtime?.id) {
                clearInterval(usageTrackingInterval);
                usageTrackingInterval = null;
                return;
            }

            const video = getVideoElement();
            if (!audioModeEnabled || !video) return;

            pendingStats.active += 5;

            if (!video.paused && !video.ended && video.readyState > 2) {
                pendingStats.listened += 5;
            }
        }, TIMING.USAGE_TRACKING_INTERVAL);

        qualityCheckInterval = setInterval(flushStatsToStorage, FLUSH_INTERVAL);

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) flushStatsToStorage();
        });
    }

    function stopUsageTracking() {
        flushStatsToStorage();
        if (usageTrackingInterval) {
            clearInterval(usageTrackingInterval);
            usageTrackingInterval = null;
        }
        if (qualityCheckInterval) {
            clearInterval(qualityCheckInterval);
            qualityCheckInterval = null;
        }
    }

    let setQualityRetries = 0;
    function setLowestQuality() {
        const player = document.getElementById('movie_player');
        const video = getVideoElement();

        if (!player || !video) {
            if (setQualityRetries < 5) {
                setQualityRetries++;
                setTimeout(setLowestQuality, 1000);
            }
            return;
        }
        setQualityRetries = 0;
        forceLowestQuality(player, video);
    }

    async function createAudioModeOverlay() {
        await loadMessages(currentLanguage);

        if (audioModeOverlay) audioModeOverlay.remove();
        // Also clear any overlay left behind by an orphaned script (extension reloaded)
        document.querySelectorAll('#youtube-audio-mode-overlay').forEach(el => el.remove());

        const videoContainer = document.querySelector('.html5-video-container') || document.querySelector('#player-container');
        if (!videoContainer) return;

        audioModeOverlay = document.createElement('div');
        audioModeOverlay.id = 'youtube-audio-mode-overlay';

        audioModeOverlay.innerHTML = buildOverlayMarkup(overlayStyle);
        audioModeOverlay.classList.add('am-style-' + overlayStyle);

        fillOverlayText();

        videoContainer.style.position = 'relative';
        videoContainer.style.width = '100%';
        videoContainer.style.height = '100%';
        videoContainer.appendChild(audioModeOverlay);
        observeOverlaySize();

        if (currentLanguage === 'ar') audioModeOverlay.setAttribute('dir', 'rtl');

        if (chrome.runtime?.id) {
            try {
                chrome.storage.sync.get(['backgroundType', 'backgroundValue'], (result) => {
                    if (!chrome.runtime.lastError) updateOverlayTheme(result.backgroundType, result.backgroundValue);
                });
            } catch (error) { }
        }

        const video = getVideoElement();

        if (video) {
            const updatePlayState = () => {
                if (!audioModeOverlay) return;
                audioModeOverlay.classList.toggle('am-paused', video.paused);
            };
            updatePlayState();

            videoPlayHandler = updatePlayState;
            videoPauseHandler = updatePlayState;
            video.addEventListener('play', videoPlayHandler);
            video.addEventListener('pause', videoPauseHandler);
        }
    }

    // Expose the overlay's size as CSS variables so visuals scale with the
    // player (container-query units are not reliable in Safari's content CSS)
    let overlayResizeObserver = null;
    function observeOverlaySize() {
        if (overlayResizeObserver) overlayResizeObserver.disconnect();
        const apply = () => {
            if (!audioModeOverlay) return;
            const r = audioModeOverlay.getBoundingClientRect();
            if (r.width && r.height) {
                audioModeOverlay.style.setProperty('--am-w', r.width + 'px');
                audioModeOverlay.style.setProperty('--am-h', r.height + 'px');
            }
        };
        apply();
        if (typeof ResizeObserver !== 'undefined' && audioModeOverlay) {
            overlayResizeObserver = new ResizeObserver(apply);
            overlayResizeObserver.observe(audioModeOverlay);
        }
    }

    function currentVideoId() {
        try { return new URLSearchParams(window.location.search).get('v'); } catch (e) { return null; }
    }

    function currentVideoTitle() {
        const el = document.querySelector('#title h1') ||
            document.querySelector('.ytd-video-primary-info-renderer h1') ||
            document.querySelector('h1.title');
        if (el && el.textContent.trim()) return el.textContent.trim();
        return (document.title || '').replace(/ - YouTube$/, '');
    }

    function thumbnailUrl() {
        const id = currentVideoId();
        return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
    }

    // Markup for each overlay style. Text nodes are filled by fillOverlayText().
    function buildOverlayMarkup(style) {
        const text = `<h2 id="am-overlay-title"></h2><p id="am-overlay-desc"></p>`;
        const thumb = thumbnailUrl();
        switch (style) {
            case 'vinyl':
                return `<div class="audio-mode-content">
      <div class="am-vinyl">
        <div class="am-vinyl-disc">
          <div class="am-vinyl-label"${thumb ? ` style="background-image:url('${thumb}')"` : ''}></div>
        </div>
        <div class="am-vinyl-arm"></div>
      </div>
      ${text}
    </div>`;
            case 'rings':
                return `<div class="audio-mode-content">
      <div class="am-rings">
        <span class="am-ring"></span><span class="am-ring"></span><span class="am-ring"></span>
        <svg class="am-rings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
      </div>
      ${text}
    </div>`;
            case 'wave':
                return `<div class="audio-mode-content">
      <div class="am-wave">
        <svg viewBox="0 0 400 80" preserveAspectRatio="none">
          <path class="am-wave-path am-wave-a" d="M0 40 C 25 10, 50 10, 75 40 S 125 70, 150 40 S 200 10, 225 40 S 275 70, 300 40 S 350 10, 375 40 S 425 70, 450 40 S 500 10, 525 40 S 575 70, 600 40 S 650 10, 675 40 S 725 70, 750 40 S 800 10, 825 40"/>
          <path class="am-wave-path am-wave-b" d="M0 40 C 25 22, 50 22, 75 40 S 125 58, 150 40 S 200 22, 225 40 S 275 58, 300 40 S 350 22, 375 40 S 425 58, 450 40 S 500 22, 525 40 S 575 58, 600 40 S 650 22, 675 40 S 725 58, 750 40 S 800 22, 825 40"/>
        </svg>
      </div>
      ${text}
    </div>`;
            case 'thumb':
                return `<div class="am-thumb-bg"${thumb ? ` style="background-image:url('${thumb}')"` : ''}></div>
    <div class="audio-mode-content">
      <div class="am-thumb-card">
        <img class="am-thumb-img" src="${thumb}" alt="">
        <div class="am-thumb-text">
          <div class="am-thumb-title" id="am-overlay-video-title" dir="auto"></div>
          ${text}
        </div>
      </div>
    </div>`;
            case 'minimal':
                return `<div class="audio-mode-content am-minimal">${text}</div>`;
            case 'bars':
            default:
                return `<div class="audio-mode-content">
      <div class="audio-visualizer">
        ${'<span class="bar"></span>'.repeat(12)}
      </div>
      ${text}
    </div>`;
        }
    }

    function fillOverlayText() {
        if (!audioModeOverlay) return;
        const title = audioModeOverlay.querySelector('#am-overlay-title');
        const desc = audioModeOverlay.querySelector('#am-overlay-desc');
        const vt = audioModeOverlay.querySelector('#am-overlay-video-title');
        if (title) title.textContent = t('activeTitle');
        if (desc) desc.textContent = t('activeDesc');
        if (vt) vt.textContent = currentVideoTitle();
    }

    // Swap the overlay's visual without recreating listeners or losing theme
    function setOverlayStyle(style) {
        if (!OVERLAY_STYLES.includes(style)) style = 'bars';
        overlayStyle = style;
        if (!audioModeOverlay) return;
        OVERLAY_STYLES.forEach(s => audioModeOverlay.classList.remove('am-style-' + s));
        audioModeOverlay.classList.add('am-style-' + style);
        audioModeOverlay.innerHTML = buildOverlayMarkup(style);
        fillOverlayText();
    }

    function formatVideoTime(seconds) {
        if (isNaN(seconds)) return "0:00";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        const mStr = m.toString().padStart(h > 0 ? 2 : 1, '0');
        const sStr = s.toString().padStart(2, '0');

        if (h > 0) return `${h}:${mStr}:${sStr}`;
        return `${m}:${sStr}`;
    }

    function updateOverlayTheme(type, value) {
        if (!audioModeOverlay) return;

        if (!type) type = 'color';
        if (!value) value = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';

        if (type === 'image') {
            audioModeOverlay.style.background = `url("${value}") no-repeat center center / cover`;
            audioModeOverlay.classList.add('has-image');
        } else {
            audioModeOverlay.style.background = value;
            audioModeOverlay.classList.remove('has-image');
        }
    }

    async function updateOverlayLanguage() {
        await loadMessages(currentLanguage);
        if (audioModeOverlay) {
            fillOverlayText();
            if (currentLanguage === 'ar') audioModeOverlay.setAttribute('dir', 'rtl');
            else audioModeOverlay.removeAttribute('dir');
        }
    }

    function applyPlaybackSpeed() {
        if (!userSetSpeed) return;
        const video = getVideoElement();
        if (video && !isApplyingSpeed) {
            if (Math.abs(video.playbackRate - currentPlaybackSpeed) > 0.01) {
                isApplyingSpeed = true;
                video.playbackRate = currentPlaybackSpeed;
                setTimeout(() => { isApplyingSpeed = false; }, 100);
            }
        }
    }

    function getPlaybackState() {
        const video = getVideoElement();
        if (!video) return null;

        let videoTitle = "YouTube Video";
        let channelName = "YouTube";
        let videoId = null;

        try {
            const titleEl = document.querySelector("#title h1") ||
                document.querySelector(".ytd-video-primary-info-renderer h1") ||
                document.querySelector("h1.title");

            if (titleEl) videoTitle = titleEl.textContent.trim();
            else if (document.title) videoTitle = document.title.replace(" - YouTube", "");

            const channelEl = document.querySelector("#upload-info #channel-name a") ||
                document.querySelector("ytd-channel-name a");
            if (channelEl) channelName = channelEl.textContent.trim();

            const urlParams = new URLSearchParams(window.location.search);
            videoId = urlParams.get('v');
        } catch (e) { }

        const thumbnailUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';

        return {
            title: videoTitle,
            channel: channelName,
            thumbnail: thumbnailUrl,
            paused: video.paused,
            currentTime: video.currentTime,
            duration: video.duration,
            playbackSpeed: video.playbackRate,
            volume: video.volume,
            muted: video.muted
        };
    }

    let lastUrl = location.href;

    function handleNavigation() {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            clearVideoCache();
            _videoPushListenersAttached = false;

            setProgrammaticLock();
            userManuallyChangedQuality = false;

            if (audioModeEnabled) {
                setTimeout(() => enableAudioMode(), TIMING.RETRY_DELAY);
            }

            setTimeout(attachVideoPushListeners, TIMING.RETRY_DELAY + 500);
        }
    }

    function initNavigationObserver() {
        document.addEventListener('yt-navigate-finish', handleNavigation);
        window.addEventListener('popstate', handleNavigation);

        const speedEnforcementEvents = ['play', 'loadedmetadata', 'loadeddata', 'canplay'];

        speedEnforcementEvents.forEach(eventName => {
            document.addEventListener(eventName, (e) => {
                if (!userSetSpeed) return;
                if (e.target.tagName === 'VIDEO') setTimeout(applyPlaybackSpeed, 150);
            });
        });

        document.addEventListener('ratechange', (e) => {
            if (!userSetSpeed) return;
            if (e.target.tagName === 'VIDEO' && !isApplyingSpeed) {
                if (Math.abs(e.target.playbackRate - currentPlaybackSpeed) > 0.01) {
                    setTimeout(() => {
                        const video = getVideoElement();
                        if (video && Math.abs(video.playbackRate - currentPlaybackSpeed) > 0.01) {
                            applyPlaybackSpeed();
                        }
                    }, 200);
                }
            }
        });
    }

    initNavigationObserver();

    setTimeout(attachVideoPushListeners, 1500);

    window.addEventListener('beforeunload', () => stopUsageTracking());
}