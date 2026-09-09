// Background script for Listen Mode
// Handles keyboard shortcuts and badge updates

// Initialize state
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get(['audioMode'], (result) => {
        const enabled = result.audioMode || false;
        updateBadge(enabled);
    });

    // Log storage quota on install
    monitorStorageQuota();
});

// Debounced badge update to prevent excessive calls
let badgeUpdateTimeout = null;
function debouncedUpdateBadge(enabled) {
    if (badgeUpdateTimeout) {
        clearTimeout(badgeUpdateTimeout);
    }
    badgeUpdateTimeout = setTimeout(() => {
        updateBadge(enabled);
    }, 100);
}

// Update badge when storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.audioMode) {
        debouncedUpdateBadge(changes.audioMode.newValue);
    }
});

function updateBadge(enabled) {
    if (enabled) {
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#667eea' });
    } else {
        chrome.action.setBadgeText({ text: '' });
    }
}

// Monitor storage quota
function monitorStorageQuota() {
    chrome.storage.sync.getBytesInUse(null, (bytes) => {
        const quotaLimit = chrome.storage.sync.QUOTA_BYTES || 102400; // 100KB
        const usagePercent = (bytes / quotaLimit) * 100;

        if (usagePercent > 90) {
            console.warn(`[Audio Mode] Storage quota at ${usagePercent.toFixed(1)}% (${bytes}/${quotaLimit} bytes)`);
        } else {
            console.log(`[Audio Mode] Storage usage: ${usagePercent.toFixed(1)}% (${bytes}/${quotaLimit} bytes)`);
        }
    });
}

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
    if (command === 'toggle-audio-mode') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const currentTab = tabs[0];
            if (currentTab && currentTab.url.includes('youtube.com')) {
                // Send toggle message to content script
                chrome.tabs.sendMessage(currentTab.id, { action: 'toggleAudioMode' }, (response) => {
                    // Update storage if content script handles it
                    // (The content script updates storage, which triggers the onChanged listener above)

                    // Fallback: inject content script if not ready (never reload the tab)
                    if (chrome.runtime.lastError) {
                        console.log('Content script not ready, injecting script...');
                        chrome.storage.sync.get(['audioMode'], async (result) => {
                            const newState = !result.audioMode;
                            await chrome.storage.sync.set({ audioMode: newState });
                            await injectContentScript(currentTab.id);
                            setTimeout(() => {
                                chrome.tabs.sendMessage(currentTab.id, { action: 'setAudioMode', enabled: newState }, () => {
                                    void chrome.runtime.lastError;
                                });
                            }, 150);
                        });
                    }
                });
            }
        });
    }
});

// Inject content script + its CSS into a tab (idempotent: content.js guards itself)
async function injectContentScript(tabId) {
    try {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['overlay.css'] });
    } catch (e) { }
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (err) {
        console.log('[Audio Mode] Could not inject script:', err);
    }
}

// Handle YouTube navigation (new tabs and SPA navigation).
// Always make sure the content script is present on watch pages — regardless of
// whether audio mode is currently on — so the popup toggle never has to reload the tab.
function handleYouTubeNavigation(tabId, url) {
    // Only handle watch pages
    if (!url || !url.includes('youtube.com/watch')) return;

    chrome.tabs.sendMessage(tabId, { action: 'getStatus' }, (response) => {
        if (chrome.runtime.lastError) {
            console.log('[Audio Mode] Injecting content script for new navigation');
            injectContentScript(tabId);
        }
    });
}

// Listen for YouTube SPA navigation (when clicking videos within YouTube)
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    // Only handle main frame navigation
    if (details.frameId === 0) {
        handleYouTubeNavigation(details.tabId, details.url);
    }
}, { url: [{ hostContains: 'youtube.com' }] });

// Listen for new tabs loading YouTube
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url?.includes('youtube.com/watch')) {
        handleYouTubeNavigation(tabId, tab.url);
    }
});
