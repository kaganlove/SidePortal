const ALARM_NAME = "tstc_poll";
const POLL_MINUTES = 1;

// Runs every time the service worker starts, not only onInstalled or onStartup
async function setOpenOnClickBehavior() {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (e) {
    // ignore
  }
}

// Fallback to explicitly open the side panel when the icon is clicked
async function openSidePanelFromClick(tab) {
  try {
    if (!chrome.sidePanel?.open) return;

    if (tab?.id != null) {
      await chrome.sidePanel.open({ tabId: tab.id });
      return;
    }

    const win = await chrome.windows.getCurrent();
    if (win?.id != null) {
      await chrome.sidePanel.open({ windowId: win.id });
    }
  } catch (e) {
    // ignore
  }
}

async function getAuthTokenInteractive(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!token) return reject(new Error("No token returned"));
      resolve(token);
    });
  });
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${text}`);
  }
  return res.json();
}

async function getGmailUnreadCount(token) {
  const data = await fetchJson(
    "https://www.googleapis.com/gmail/v1/users/me/profile",
    token
  );
  return Number(data.messagesUnread || 0);
}

function parseChatUnreadFromTitle(title) {
  const m = title.match(/^\((\d+)\)\s/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

async function getChatUnreadBestEffort() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "https://chat.google.com/*" }, (tabs) => {
      if (!tabs || tabs.length === 0) return resolve(0);
      let total = 0;
      for (const t of tabs) total += parseChatUnreadFromTitle(t.title || "");
      resolve(total);
    });
  });
}

async function setBadge(hasAny) {
  if (hasAny) await chrome.action.setBadgeText({ text: "•" });
  else await chrome.action.setBadgeText({ text: "" });
}

async function notifyIfChanged(prev, next) {
  const prevAny = (prev.gmailUnread > 0) || (prev.chatUnread > 0);
  const nextAny = (next.gmailUnread > 0) || (next.chatUnread > 0);

  if (!prevAny && nextAny) {
    const parts = [];
    if (next.gmailUnread > 0) parts.push("email");
    if (next.chatUnread > 0) parts.push("chat");

    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "TSTC Sidebar",
      message: `You have new ${parts.join(" and ")} activity.`,
      priority: 1
    });
  }
}

async function pollOnce({ interactiveAuth = false } = {}) {
  let gmailUnread = 0;
  let chatUnread = 0;

  try {
    const token = await getAuthTokenInteractive(interactiveAuth);
    gmailUnread = await getGmailUnreadCount(token);
    await chrome.storage.local.set({ lastAuthError: "" });
  } catch (e) {
    await chrome.storage.local.set({
      lastAuthError: String(e?.message || e)
    });
    gmailUnread = 0;
  }

  try {
    chatUnread = await getChatUnreadBestEffort();
  } catch (e) {
    chatUnread = 0;
  }

  const next = { gmailUnread, chatUnread };

  const { notifState } = await chrome.storage.local.get(["notifState"]);
  const prev = notifState || { gmailUnread: 0, chatUnread: 0 };

  await notifyIfChanged(prev, next);
  await chrome.storage.local.set({ notifState: next });

  await setBadge((gmailUnread > 0) || (chatUnread > 0));
}

// IMPORTANT: run on every worker start, so reloads also set the behavior
setOpenOnClickBehavior().catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  await setOpenOnClickBehavior();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  pollOnce({ interactiveAuth: false }).catch(() => {});
});

chrome.runtime.onStartup?.addListener?.(() => {
  setOpenOnClickBehavior().catch(() => {});
});

// Fallback that guarantees icon click opens the side panel (when API is available)
chrome.action?.onClicked?.addListener((tab) => {
  openSidePanelFromClick(tab).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  pollOnce({ interactiveAuth: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "AUTH_AND_REFRESH") {
    pollOnce({ interactiveAuth: true })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === "GET_LAST_AUTH_ERROR") {
    chrome.storage.local.get(["lastAuthError"]).then(({ lastAuthError }) => {
      sendResponse({ ok: true, lastAuthError: lastAuthError || "" });
    });
    return true;
  }

  // Optional: if you ever want the panel to request opening itself
  if (msg?.type === "OPEN_SIDEPANEL") {
    openSidePanelFromClick(sender?.tab)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
