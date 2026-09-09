// Popup script for Listen Mode

const audioToggle = document.getElementById('audioToggle');
const supportBtn = document.getElementById('support-btn');
const langBtn = document.getElementById('lang-btn');
const speedSelect = document.getElementById('speed-select');

// Music Player Elements
const musicPlayer = document.getElementById('musicPlayer');
const amThumbnail = document.getElementById('am-thumbnail-img');
const amPlaceholder = document.getElementById('am-placeholder-art');
const amTitle = document.getElementById('am-video-title');
const amChannel = document.getElementById('am-channel-name');
const amProgressBar = document.getElementById('am-progress-bar');
const amProgressFill = document.getElementById('am-progress-fill');
const amCurrentTime = document.getElementById('am-current-time');
const amTotalTime = document.getElementById('am-total-time');
const amPlayPauseBtn = document.getElementById('am-play-pause-btn');

// Current language and loaded messages
let currentLang = 'en';
let loadedMessages = {};
// Global Tab ID for the target YouTube tab
let targetTabId = null;

// Helper function to get translated messages
function t(messageName) {
    // First try to get from loaded messages (for custom language selection)
    if (loadedMessages[messageName] && loadedMessages[messageName].message) {
        return loadedMessages[messageName].message;
    }
    // Fallback to chrome.i18n if not loaded yet
    return chrome.i18n.getMessage(messageName) || messageName;
}

// Load messages for a specific language
async function loadMessages(lang) {
    try {
        const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
        const response = await fetch(url);
        const messages = await response.json();
        loadedMessages = messages;
        currentLang = lang;
        return messages;
    } catch (error) {
        console.error(`Failed to load messages for ${lang}:`, error);
        return null;
    }
}

async function setLanguage(lang) {
    // Load messages for the selected language
    await loadMessages(lang);
    currentLang = lang;

    // Update direction
    document.body.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;

    // Update button text
    langBtn.textContent = lang === 'ar' ? 'En' : 'ع';
    langBtn.title = lang === 'ar' ? 'English' : 'Arabic';

    // Update all elements with data-i18n
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translation = t(key);
        if (translation) {
            el.textContent = translation;
        }
    });

    // Update placeholders
    const urlInput = document.getElementById('custom-image-url');
    if (urlInput) {
        urlInput.placeholder = 'https://example.com/image.jpg';
    }

    // Update dynamic status text if needed
    if (targetTabId) {
        updateUI(audioToggle.checked);
    }
    updateStats(); // Refresh stats to apply new units

    // Save preference
    chrome.storage.sync.set({ language: lang });

    // Broadcast to target tab
    if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, {
            action: 'updateLanguage',
            language: lang
        }).catch(() => {
            // Ignore errors if content script is not ready
        });
    }
}

// Initialize Language
chrome.storage.sync.get(['language'], (result) => {
    // Use stored language preference, or detect from browser
    const detectedLang = chrome.i18n.getUILanguage().startsWith('ar') ? 'ar' : 'en';
    setLanguage(result.language || detectedLang);

    // Initialize Speed
    chrome.storage.sync.get(['playbackSpeed'], (res) => {
        const speed = res.playbackSpeed || 1;
        if (speedSelect) {
            speedSelect.value = speed;
        }
    });
});


// Language Toggle Handler
langBtn.addEventListener('click', () => {
    const newLang = currentLang === 'en' ? 'ar' : 'en';
    setLanguage(newLang);
});


// ===== NEW TAB DISCOVERY LOGIC =====

async function findTargetTab() {
    // 1. Check Active Tab First
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url && activeTab.url.match(/youtube\.com\/watch/)) {
        return activeTab;
    }

    // 2. Search for background YouTube tabs
    const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });

    if (tabs.length === 0) return null;

    // 3. Sort tabs: Audible tags first, then general
    tabs.sort((a, b) => {
        if (a.audible && !b.audible) return -1;
        if (!a.audible && b.audible) return 1;
        return 0;
    });

    return tabs[0];
}

// Initialize popup state
(async function init() {
    const tab = await findTargetTab();

    if (!tab) {
        // No YouTube tab found anywhere
        audioToggle.disabled = true;
        const st = document.getElementById('status-text');
        if (st) { st.setAttribute('data-i18n', 'onlyYoutube'); st.textContent = t('onlyYoutube'); }
        document.getElementById('hero')?.classList.add('disabled');
        return;
    }

    targetTabId = tab.id;
    console.log("Connected to YouTube tab:", tab.title);

    // Get current audio mode status from content script
    try {
        const response = await chrome.tabs.sendMessage(targetTabId, { action: 'getStatus' });
        if (response) {
            updateUI(response.enabled);
        } else {
            checkStorageState();
        }
    } catch (error) {
        // Content script not ready yet, check storage
        console.log('Content script not ready:', error.message);
        checkStorageState();
    }

    // Initialize Music Player
    requestPlaybackState();
    startPlaybackPolling();
})();

// Fallback function to check storage
function checkStorageState() {
    chrome.storage.sync.get(['audioMode'], (result) => {
        updateUI(result.audioMode || false);
    });
}

// Inject the content script (and its CSS) into a tab that doesn't have it yet.
// Never reloads the page — a reload restarts the video from the beginning.
async function ensureContentScript(tabId) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['overlay.css'] }).catch(() => { });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

// Handle toggle change
audioToggle.addEventListener('change', async () => {
    const enabled = audioToggle.checked;
    if (!targetTabId) return;

    const sendToggle = () => chrome.tabs.sendMessage(targetTabId, { action: 'toggleAudioMode' });

    try {
        const response = await sendToggle();
        if (response) updateUI(response.enabled);
        return;
    } catch (error) {
        console.log('Content script not reachable, injecting:', error.message);
    }

    // Content script missing (SPA navigation / extension reloaded / page not idle yet).
    // Inject it in place, then retry — no page reload.
    try {
        await chrome.storage.sync.set({ audioMode: enabled });
        await ensureContentScript(targetTabId);
        // Give the script a moment to register its message listener
        await new Promise(r => setTimeout(r, 150));
        // Explicit state (not toggle) — the injected script may already have
        // applied the stored state during its own init.
        const response = await chrome.tabs.sendMessage(targetTabId, { action: 'setAudioMode', enabled });
        if (response) {
            updateUI(response.enabled);
            return;
        }
    } catch (error) {
        console.log('Injection fallback failed:', error.message);
    }

    // Last resort: persist the desired state; content script picks it up on next load
    chrome.storage.sync.set({ audioMode: enabled }, () => updateUI(enabled));
});


// Speed Slider Logic
if (speedSelect) {
    speedSelect.addEventListener('change', (e) => {
        const speed = parseFloat(e.target.value);

        // Save to storage
        chrome.storage.sync.set({ playbackSpeed: speed, userSetSpeed: true });

        // Send to target tab
        if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, {
                action: 'setPlaybackSpeed',
                speed: speed
            });
        }
    });
}

// Volume Control Logic
const volumeSelect = document.getElementById('volume-select');
if (volumeSelect) {
    // Initialize Volume
    chrome.storage.sync.get(['volume'], (res) => {
        const volume = res.volume !== undefined ? res.volume : 1;
        volumeSelect.value = volume;
    });

    volumeSelect.addEventListener('change', (e) => {
        const volume = parseFloat(e.target.value);

        // Save to storage
        chrome.storage.sync.set({ volume: volume });

        // Send to target tab
        if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, {
                action: 'setVolume',
                volume: volume
            });
        }
    });
}

// Restore Quality Logic (quality the video returns to when audio mode is off).
// Chips on the main screen. Change is pushed to the tab instantly — content.js
// applies it via the player API on the next disable, never via a page reload.
const qualityChips = Array.from(document.querySelectorAll('#quality-chips .chip'));

function markQualityChip(quality) {
    qualityChips.forEach(chip => {
        const selected = chip.dataset.quality === quality;
        chip.classList.toggle('active', selected);
        chip.setAttribute('aria-pressed', String(selected));
    });
}

if (qualityChips.length) {
    chrome.storage.sync.get(['restoreQuality'], (res) => {
        markQualityChip(res.restoreQuality || 'hd720');
    });

    qualityChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const quality = chip.dataset.quality;
            markQualityChip(quality);

            chip.classList.remove('applied');
            void chip.offsetWidth; // restart animation
            chip.classList.add('applied');

            chrome.storage.sync.set({ restoreQuality: quality });

            if (targetTabId) {
                chrome.tabs.sendMessage(targetTabId, {
                    action: 'updateRestoreQuality',
                    quality: quality
                }).catch(() => {
                    // Content script not ready — it reads restoreQuality from storage on init
                });
            }
        });
    });
}


// Overlay style chips — what replaces the video while Listen Mode is on
const styleChips = Array.from(document.querySelectorAll('#style-chips .chip'));

function markStyleChip(style) {
    styleChips.forEach(chip => {
        const selected = chip.dataset.style === style;
        chip.classList.toggle('active', selected);
        chip.setAttribute('aria-pressed', String(selected));
    });
}

if (styleChips.length) {
    chrome.storage.sync.get(['overlayStyle'], (res) => {
        markStyleChip(res.overlayStyle || 'bars');
    });

    styleChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const style = chip.dataset.style;
            markStyleChip(style);
            chip.classList.remove('applied');
            void chip.offsetWidth;
            chip.classList.add('applied');

            chrome.storage.sync.set({ overlayStyle: style });

            if (targetTabId) {
                chrome.tabs.sendMessage(targetTabId, { action: 'updateOverlayStyle', style })
                    .catch(() => { /* content script reads overlayStyle from storage on init */ });
            }
        });
    });
}


// ===== MUSIC PLAYER LOGIC =====

function requestPlaybackState() {
    if (!targetTabId) return;

    chrome.tabs.sendMessage(targetTabId, { action: 'getPlaybackState' }, (response) => {
        if (!chrome.runtime.lastError && response) {
            updateMusicPlayerUI(response);
        } else {
            // Hide player if no content script response (not on YouTube or error)
            musicPlayer.classList.add('hidden');
        }
    });
}

let playbackPollInterval = null;
function startPlaybackPolling() {
    // Reduced fallback poll (3s) — primary sync is now event-driven via
    // chrome.runtime.onMessage receiving 'playbackStateUpdate' from content script.
    if (playbackPollInterval) clearInterval(playbackPollInterval);
    playbackPollInterval = setInterval(requestPlaybackState, 3000);
}

// Listen for real-time state pushed from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'playbackStateUpdate' && message.state) {
        updateMusicPlayerUI(message.state);
    }
});

function updateMusicPlayerUI(state) {
    if (!state) return;

    // Show player
    musicPlayer.classList.remove('hidden');

    // Metadata
    // Clean up title if needed (remove (1) etc)
    const displayTitle = state.title || t('noVideo');
    // A real title must not be overwritten by the i18n pass in setLanguage()
    if (state.title) amTitle.removeAttribute('data-i18n');
    else amTitle.setAttribute('data-i18n', 'noVideo');
    if (amTitle.textContent !== displayTitle) {
        amTitle.textContent = displayTitle;

        // Check for overflow and enable scrolling
        const wrapper = amTitle.parentElement;
        // Reset first
        amTitle.classList.remove('moving');
        amTitle.style.removeProperty('--scroll-distance');

        // Marquee direction must follow the text's own direction (Arabic title in
        // an English UI, or vice versa), not the popup language
        const rtlText = wrapper && getComputedStyle(wrapper).direction === 'rtl';
        amTitle.classList.toggle('rtl-text', !!rtlText);

        // Force layout update and check overflow
        if (wrapper && amTitle.scrollWidth > wrapper.clientWidth) {
            const overflow = amTitle.scrollWidth - wrapper.clientWidth;
            // Scroll just enough to see the end, plus a little buffer
            const buffer = 10;
            amTitle.style.setProperty('--scroll-distance', `-${overflow + buffer}px`);

            // Adjust speed based on distance (approx 25px per second + pause time compensation)
            // Increased multiplier to keep movement readable with the new pauses
            const duration = Math.max(5, (overflow + buffer) * 0.08);
            amTitle.style.animationDuration = `${duration}s`;

            amTitle.classList.add('moving');
        }
    }
    amChannel.textContent = state.channel || 'YouTube';

    // Thumbnail
    if (state.thumbnail) {
        amThumbnail.src = state.thumbnail;
        amThumbnail.classList.remove('hidden');
        amPlaceholder.classList.add('hidden');
    } else {
        amThumbnail.classList.add('hidden');
        amPlaceholder.classList.remove('hidden');
    }

    // Controls
    const playIcon = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    const pauseIcon = `<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

    amPlayPauseBtn.innerHTML = state.paused ? playIcon : pauseIcon;
    amPlayPauseBtn.disabled = false;

    // Timeline
    if (state.duration && !isNaN(state.duration)) {
        amProgressBar.disabled = false;
        amProgressBar.max = state.duration;
        amProgressBar.value = state.currentTime;

        amCurrentTime.textContent = formatTime(state.currentTime);
        amTotalTime.textContent = formatTime(state.duration);

        const percent = (state.currentTime / state.duration) * 100;
        amProgressFill.style.width = `${percent}%`;
    } else {
        amProgressBar.disabled = true;
        amCurrentTime.textContent = "0:00";
        amTotalTime.textContent = "0:00";
        amProgressFill.style.width = "0%";
    }

    // Sync speed dropdown from actual video state (catches native YouTube speed changes)
    if (state.playbackSpeed && speedSelect) {
        const currentSpeedVal = parseFloat(speedSelect.value);
        if (Math.abs(currentSpeedVal - state.playbackSpeed) > 0.01) {
            speedSelect.value = state.playbackSpeed;
        }
    }

    // Sync volume dropdown from actual video state (catches native YouTube volume changes)
    if (state.volume !== undefined && volumeSelect) {
        // Find the closest option value
        const options = Array.from(volumeSelect.options).map(o => parseFloat(o.value));
        const closest = options.reduce((prev, curr) =>
            Math.abs(curr - state.volume) < Math.abs(prev - state.volume) ? curr : prev
        );
        if (parseFloat(volumeSelect.value) !== closest) {
            volumeSelect.value = closest;
        }
    }
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const mStr = m.toString().padStart(h > 0 ? 2 : 1, '0');
    const sStr = s.toString().padStart(2, '0');

    if (h > 0) return `${h}:${mStr}:${sStr}`;
    return `${m}:${sStr}`;
}

const amJumpBackBtn = document.getElementById('am-jump-back');
const amJumpForwardBtn = document.getElementById('am-jump-forward');

// User Actions
amPlayPauseBtn.addEventListener('click', () => {
    if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, { action: 'togglePlayback' });
        // Optimistic UI update could go here
        requestPlaybackState(); // Refresh state immediately
    }
});

if (amJumpBackBtn) {
    amJumpBackBtn.addEventListener('click', () => {
        if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, { action: 'seekBy', offset: -10 });
        }
    });
}

if (amJumpForwardBtn) {
    amJumpForwardBtn.addEventListener('click', () => {
        if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, { action: 'seekBy', offset: 10 });
        }
    });
}

let seekTimeout = null;
amProgressBar.addEventListener('input', (e) => {
    const time = parseFloat(e.target.value);

    // Update UI immediately for drag effect
    amCurrentTime.textContent = formatTime(time);
    const percent = (time / amProgressBar.max) * 100;
    amProgressFill.style.width = `${percent}%`;

    // Debounce send seek command
    clearTimeout(seekTimeout);
    seekTimeout = setTimeout(() => {
        if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, { action: 'seek', time: time });
        }
    }, 200);
});

// ===== EXISTING LOGIC =====

const heroEl = document.getElementById('hero');
const statusTextEl = document.getElementById('status-text');
const brandDotEl = document.getElementById('brand-dot');

function updateUI(enabled) {
    audioToggle.checked = enabled;
    if (heroEl) heroEl.classList.toggle('on', enabled);
    if (brandDotEl) brandDotEl.classList.toggle('on', enabled);
    if (statusTextEl) {
        statusTextEl.setAttribute('data-i18n', enabled ? 'statusOn' : 'statusOff');
        statusTextEl.textContent = t(enabled ? 'statusOn' : 'statusOff');
    }
}

// Stats Update Logic
let currentFilter = 'month'; // 'month' or 'all'

const filterBtns = document.querySelectorAll('.stats-filter');
filterBtns.forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        currentFilter = btn.dataset.filter;
        updateStats();
    });
});

function updateStats() {
    try {
        // Get both logs
        chrome.storage.local.get(['statsLogs', 'activeLogs', 'audioModeSeconds'], (result) => {
            const statsLogs = result.statsLogs || {};
            const activeLogs = result.activeLogs || {};

            // Legacy support: if we have audioModeSeconds but no logs, maybe credit it to today?
            // Or just ignore legacy data for the new accurate system. 
            // Let's rely on new logs.

            const now = new Date();
            const currentMonthPrefix = now.toISOString().slice(0, 7); // YYYY-MM

            let totalListenedSeconds = 0;
            let totalActiveSeconds = 0;

            // Aggregate Listened Time (Accurate Playback)
            Object.entries(statsLogs).forEach(([date, seconds]) => {
                if (currentFilter === 'month') {
                    if (date.startsWith(currentMonthPrefix)) {
                        totalListenedSeconds += seconds;
                    }
                } else {
                    totalListenedSeconds += seconds;
                }
            });

            // Aggregate Active Time (Wall Clock)
            Object.entries(activeLogs).forEach(([date, seconds]) => {
                if (currentFilter === 'month') {
                    if (date.startsWith(currentMonthPrefix)) {
                        totalActiveSeconds += seconds;
                    }
                } else {
                    totalActiveSeconds += seconds;
                }
            });

            // Calculate Data
            const listenedMinutes = totalListenedSeconds / 60;

            // Data Rates (MB per minute)
            const RATE_144P = 0.75;
            const RATE_720P = 18.75;
            const RATE_1080P = 33.75;

            const usage144p = listenedMinutes * RATE_144P;
            const usage720p = listenedMinutes * RATE_720P;
            const usage1080p = listenedMinutes * RATE_1080P;

            const savedVs720p = usage720p - usage144p;
            const savedVs1080p = usage1080p - usage144p;

            // Update UI
            const dataUsedElement = document.getElementById('data-used-value');
            const dataSavedElement = document.getElementById('data-saved-value');
            const listenedTimeElement = document.getElementById('listened-time-value');
            const activeTimeElement = document.getElementById('active-time-value');

            if (dataUsedElement) {
                dataUsedElement.textContent = formatData(usage144p);
            }

            if (dataSavedElement) {
                dataSavedElement.textContent = formatData(savedVs720p);
            }

            if (listenedTimeElement) {
                listenedTimeElement.textContent = formatTime(totalListenedSeconds);
            }

            if (activeTimeElement) {
                activeTimeElement.textContent = formatTime(totalActiveSeconds);
            }
        });
    } catch (error) {
        console.error('[Audio Mode] Error updating stats:', error);
    }
}

function formatData(mb) {
    const unitGB = t('unitGB');
    const unitMB = t('unitMB');
    if (mb >= 1024) {
        return `${(mb / 1024).toFixed(2)}${unitGB}`;
    }
    return `${Math.round(mb)}${unitMB}`;
}

// Update stats immediately
updateStats();

// Listen for storage changes instead of polling
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && (changes.statsLogs || changes.activeLogs)) {
        updateStats();
    }
});

// Display and Manage Shortcuts
function updateShortcutDisplay() {
    const keysContainer = document.getElementById('shortcut-display');
    if (!keysContainer) return;

    // Helper to setup click handler
    const setupClickable = () => {
        keysContainer.classList.add('clickable');
        keysContainer.title = 'Click to configure extension shortcuts';
        keysContainer.onclick = () => {
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        };
    };

    if (!chrome.commands) {
        // Fallback for contexts where chrome.commands isn't available
        chrome.runtime.getPlatformInfo((info) => {
            if (info.os === 'mac') {
                keysContainer.innerHTML = '<kbd>Option</kbd> + <kbd>Shift</kbd> + <kbd>A</kbd>';
            } else {
                keysContainer.innerHTML = '<kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>A</kbd>';
            }
        });
        return;
    }

    chrome.commands.getAll((commands) => {
        const toggleCommand = commands.find(c => c.name === 'toggle-audio-mode');

        if (toggleCommand && toggleCommand.shortcut) {
            chrome.runtime.getPlatformInfo((info) => {
                let shortcutDisplay = toggleCommand.shortcut;

                // Customize for Mac: "Option" instead of "Alt"
                if (info.os === 'mac') {
                    shortcutDisplay = shortcutDisplay.replace('Alt', 'Option');
                }

                // Shortcut is set, display it
                const parts = shortcutDisplay.split('+');
                const html = parts.map(part => `<kbd>${part.trim()}</kbd>`).join(' + ');
                keysContainer.innerHTML = html;
            });
        } else {
            // No shortcut set
            keysContainer.innerHTML = '<span class="set-shortcut-link">⚠️ Click to set shortcut</span>';
        }

        // ALWAYS make it clickable/configurable
        setupClickable();
    });
}

// Initial call
updateShortcutDisplay();

// --- Settings Panel Logic ---

const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const closeSettingsBtn = document.getElementById('close-settings');
const colorOptions = document.getElementById('color-options');
const imageOptions = document.getElementById('image-options');
const toggleBtns = document.querySelectorAll('.toggle-btn');
const themeBtns = document.querySelectorAll('.theme-btn');
const colorPicker = document.getElementById('custom-color-picker');
const colorValueText = document.getElementById('color-value-text');
const imageUrlInput = document.getElementById('custom-image-url');
const applyImageBtn = document.getElementById('apply-image-btn');

// Toggle Settings Panel
settingsBtn.setAttribute('aria-controls', 'settings-panel');
settingsBtn.setAttribute('aria-expanded', 'false');

function setSettingsOpen(open) {
    settingsPanel.inert = !open;
    settingsPanel.classList.toggle('open', open);
    settingsBtn.setAttribute('aria-expanded', String(open));
    // Prevent keyboard navigation into the screen covered by the sheet.
    for (const sibling of settingsPanel.parentElement.children) {
        if (sibling !== settingsPanel) sibling.inert = open;
    }
    (open ? closeSettingsBtn : settingsBtn).focus();
}

settingsBtn.addEventListener('click', () => {
    setSettingsOpen(true);
});

closeSettingsBtn.addEventListener('click', () => {
    setSettingsOpen(false);
});

settingsPanel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        event.preventDefault();
        setSettingsOpen(false);
    } else if (event.key === 'Tab') {
        const focusable = Array.from(settingsPanel.querySelectorAll('button, input, select, a[href]'))
            .filter(element => !element.disabled && element.getClientRects().length);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }
});

// Load Saved Settings
chrome.storage.sync.get(['backgroundType', 'backgroundValue'], (result) => {
    const type = result.backgroundType || 'color';
    const value = result.backgroundValue || 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';

    // Set Type Toggle
    toggleBtns.forEach(btn => {
        if (btn.dataset.type === type) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Show correct section
    if (type === 'image') {
        colorOptions.classList.add('hidden');
        imageOptions.classList.remove('hidden');
        imageUrlInput.value = value;
    } else {
        colorOptions.classList.remove('hidden');
        imageOptions.classList.add('hidden');

        // Try to match preset
        // If value starts with #, it might be custom color
        if (value.startsWith('#')) {
            colorPicker.value = value;
            colorValueText.textContent = value;
        }
    }
});

// Handle Type Toggle
toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove active from all
        toggleBtns.forEach(b => b.classList.remove('active'));
        // Add to clicked
        btn.classList.add('active');

        const type = btn.dataset.type;
        if (type === 'color') {
            colorOptions.classList.remove('hidden');
            imageOptions.classList.add('hidden');
            // Re-apply current color/preset
            saveAndApplyTheme('color', getCurrentColorValue());
        } else {
            colorOptions.classList.add('hidden');
            imageOptions.classList.remove('hidden');
            // Re-apply current image
            saveAndApplyTheme('image', imageUrlInput.value);
        }
    });
});

// Handle Presets
themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove active class from all
        themeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const bg = btn.style.background;
        saveAndApplyTheme('color', bg);
    });
});

// Handle Color Picker
colorPicker.addEventListener('input', (e) => {
    const color = e.target.value;
    colorValueText.textContent = color;
    // Remove active from presets
    themeBtns.forEach(b => b.classList.remove('active'));

    saveAndApplyTheme('color', color);
});

// Handle Image Apply
applyImageBtn.addEventListener('click', () => {
    const url = imageUrlInput.value.trim();
    if (url) {
        saveAndApplyTheme('image', url);
        // Visual feedback
        const originalText = applyImageBtn.textContent;
        applyImageBtn.textContent = t('applied');
        setTimeout(() => {
            applyImageBtn.textContent = originalText;
        }, 1500);
    }
});

function getCurrentColorValue() {
    // Check if a preset is active
    const activePreset = document.querySelector('.theme-btn.active');
    if (activePreset) {
        return activePreset.style.background;
    }
    // Otherwise return picker value
    return colorPicker.value;
}

function saveAndApplyTheme(type, value) {
    if (!value) return; // Don't save empty values

    // Save to storage
    chrome.storage.sync.set({
        backgroundType: type,
        backgroundValue: value
    });

    // Send to target tab
    if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, {
            action: 'updateTheme',
            backgroundType: type,
            backgroundValue: value
        }).catch(() => {
            // Ignore errors if content script is not ready
        });
    }
}

// Support Button Logic
if (supportBtn) {
    supportBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://github.com/momahdy2029/listen-mode' });
    });
}
