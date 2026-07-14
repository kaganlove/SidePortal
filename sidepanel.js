// sidepanel.js

const STORAGE_KEYS = {
  myLinks: "myLinks",
  joinedOrg: "joinedOrg",
  offlineOrgs: "offlineOrgs",
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  const el = $("status");
  if (el) el.textContent = text || "";
}

function openUrl(url) {
  chrome.tabs.create({ url });
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function getSync(keys) {
  return chrome.storage.sync.get(keys);
}
async function setSync(obj) {
  return chrome.storage.sync.set(obj);
}

// ------------------------------
// Google auth & Logout
// ------------------------------
function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message || String(err)));
      if (!token) return reject(new Error("No token returned from chrome.identity.getAuthToken"));
      resolve(token);
    });
  });
}

async function connectGoogle() {
  try {
    setStatus("Connecting to Google...");
    await getAuthToken(true);
    setStatus("Connected.");
    await loadCalendar();
    // Refresh notifications immediately
    chrome.runtime.sendMessage({ type: "AUTH_AND_REFRESH" }, () => {});
  } catch (e) {
    console.error("Google connect failed:", e);
    setStatus("Google connect failed: " + (e?.message || String(e)));
    alert("Google connect failed: " + (e?.message || String(e)));
  }
}

async function logoutGoogle() {
  try {
    setStatus("Logging out of Google...");
    const token = await getAuthToken(false).catch(() => null);
    if (token) {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
      await new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token }, resolve);
      });
    }
    setStatus("Logged out of Google.");
    alert("Logged out of Google successfully.");
    // Clear notifications and calendar
    await chrome.storage.local.set({ notifState: { gmailUnread: 0, chatUnread: 0 } });
    updateNotifUI({ gmailUnread: 0, chatUnread: 0 });
    await loadCalendar();
  } catch (e) {
    console.error(e);
    setStatus("Google logout failed: " + (e?.message || String(e)));
  }
}

// ------------------------------
// Drive search
// ------------------------------
function openDriveSearch() {
  const q = $("driveQuery")?.value?.trim();
  if (!q) return;
  openUrl(`https://drive.google.com/drive/search?q=${encodeURIComponent(q)}`);
}

// ------------------------------
// Calendar
// ------------------------------
async function fetchCalendarEvents(token) {
  const timeMin = new Date().toISOString();
  const url =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
    `?singleEvents=true&orderBy=startTime&maxResults=10&timeMin=${encodeURIComponent(timeMin)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendar error: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

function formatEventTime(ev) {
  const start = ev.start?.dateTime || ev.start?.date;
  if (!start) return "Unknown";
  const d = new Date(start);
  return d.toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderCalendar(items, isAuthorized) {
  const list = $("calendar");
  if (!list) return;

  list.innerHTML = "";

  if (!isAuthorized) {
    const row = document.createElement("div");
    row.className = "muted";
    row.style.cursor = "pointer";
    row.textContent = "Connect Google to see calendar events.";
    row.addEventListener("click", connectGoogle);
    list.appendChild(row);
    return;
  }

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No upcoming events.";
    list.appendChild(empty);
    return;
  }

  for (const ev of items) {
    const row = document.createElement("div");
    row.className = "item";
    row.style.cursor = "pointer";

    const left = document.createElement("div");
    left.style.overflow = "hidden";

    const title = document.createElement("a");
    title.textContent = ev.summary || "Untitled";
    left.appendChild(title);

    const when = document.createElement("small");
    when.textContent = formatEventTime(ev);
    left.appendChild(when);

    row.appendChild(left);

    row.addEventListener("click", () => {
      if (ev.htmlLink) openUrl(ev.htmlLink);
    });

    list.appendChild(row);
  }
}

async function loadCalendar() {
  try {
    const token = await getAuthToken(false);
    const items = await fetchCalendarEvents(token);
    renderCalendar(items, true);
  } catch (e) {
    renderCalendar([], false);
  }
}

// ------------------------------
// Notifications (Live Updates)
// ------------------------------
function updateNotifUI(state) {
  const chatVal = state?.chatUnread || 0;
  const emailVal = state?.gmailUnread || 0;

  const chatTab = $("tabChat");
  const emailTab = $("tabEmail");

  if (chatTab) {
    const label = chatTab.querySelector(".label");
    if (chatVal > 0) {
      chatTab.classList.add("unread");
      if (label) label.textContent = `Chat (${chatVal})`;
    } else {
      chatTab.classList.remove("unread");
      if (label) label.textContent = "Chat";
    }
  }

  if (emailTab) {
    const label = emailTab.querySelector(".label");
    if (emailVal > 0) {
      emailTab.classList.add("unread");
      if (label) label.textContent = `Email (${emailVal})`;
    } else {
      emailTab.classList.remove("unread");
      if (label) label.textContent = "Email";
    }
  }
}

async function loadNotifications() {
  const { notifState } = await chrome.storage.local.get(["notifState"]);
  updateNotifUI(notifState);

  // Trigger background poll to verify new counts
  chrome.runtime.sendMessage({ type: "AUTH_AND_REFRESH" }, () => {});
}

// ------------------------------
// My Links CRUD
// ------------------------------
function renderMyLinks(arr) {
  const list = $("myLinks");
  if (!list) return;

  list.innerHTML = "";

  if (!arr.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No links added yet. Click Add.";
    list.appendChild(empty);
    return;
  }

  arr.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "item";

    const left = document.createElement("div");
    left.style.overflow = "hidden";

    const nameLink = document.createElement("a");
    nameLink.href = "#";
    nameLink.textContent = item.name || "Untitled";
    nameLink.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(item.url);
    });

    const urlSmall = document.createElement("small");
    urlSmall.textContent = item.url || "";

    left.appendChild(nameLink);
    left.appendChild(urlSmall);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const openBtn = document.createElement("button");
    openBtn.className = "icon-btn";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => openUrl(item.url));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn warn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteMyLink(index));

    actions.appendChild(openBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(left);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function loadMyLinks() {
  const { myLinks } = await getSync([STORAGE_KEYS.myLinks]);
  const arr = Array.isArray(myLinks) ? myLinks : [];
  renderMyLinks(arr);
}

async function addMyLink() {
  const name = (prompt("Link name?") || "").trim();
  if (!name) return;

  const rawUrl = (prompt("URL? (must start with https://)") || "").trim();
  const url = safeUrl(rawUrl);
  if (!url) {
    alert("That URL is not valid. Use https://...");
    return;
  }

  const { myLinks } = await getSync([STORAGE_KEYS.myLinks]);
  const arr = Array.isArray(myLinks) ? myLinks : [];
  arr.push({ name, url });

  await setSync({ [STORAGE_KEYS.myLinks]: arr });
  renderMyLinks(arr);
}

async function deleteMyLink(index) {
  const { myLinks } = await getSync([STORAGE_KEYS.myLinks]);
  const arr = Array.isArray(myLinks) ? myLinks : [];
  arr.splice(index, 1);
  await setSync({ [STORAGE_KEYS.myLinks]: arr });
  renderMyLinks(arr);
}

// ------------------------------
// Organization Quick Links (Supabase & Offline Fallback)
// ------------------------------
function isSupabaseAvailable() {
  return window.sb !== undefined;
}

function generateOrgCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function getOrgLinks(orgId, orgCode) {
  if (isSupabaseAvailable()) {
    try {
      const { data, error } = await window.sb
        .from("organization_links")
        .select("*")
        .eq("org_id", orgId)
        .order("created_at", { ascending: true });
      if (!error) return data || [];
      console.warn("Supabase fetch links failed, using offline fallback:", error);
    } catch (e) {
      console.warn("Supabase fetch links exception, using offline fallback:", e);
    }
  }

  const { offlineOrgs } = await getSync([STORAGE_KEYS.offlineOrgs]);
  const orgs = offlineOrgs || {};
  if (orgs[orgCode]) {
    return orgs[orgCode].links || [];
  }
  return [];
}

async function createOrganization(name, code) {
  let orgId = null;
  let success = false;

  if (isSupabaseAvailable()) {
    try {
      const { data, error } = await window.sb
        .from("organizations")
        .insert([{ name, code }])
        .select();
      if (!error && data && data.length > 0) {
        orgId = data[0].id;
        success = true;
      } else {
        console.warn("Supabase create org failed, trying offline:", error);
      }
    } catch (e) {
      console.warn("Supabase create org exception, trying offline:", e);
    }
  }

  if (!success) {
    orgId = "offline-" + Date.now();
    const { offlineOrgs } = await getSync([STORAGE_KEYS.offlineOrgs]);
    const orgs = offlineOrgs || {};
    orgs[code] = {
      id: orgId,
      name,
      links: [
        { name: "TSTC Portal", url: "https://tstc.edu" },
        { name: `${name} Guidelines`, url: "https://example.com" }
      ]
    };
    await setSync({ [STORAGE_KEYS.offlineOrgs]: orgs });
  }

  return { id: orgId, name, code, isOffline: !success };
}

async function fetchOrgByCode(code) {
  if (isSupabaseAvailable()) {
    try {
      const { data, error } = await window.sb
        .from("organizations")
        .select("*")
        .eq("code", code)
        .maybeSingle();
      if (!error && data) {
        return { id: data.id, name: data.name, code: data.code, isOffline: false };
      }
      console.warn("Supabase join org failed, trying offline:", error);
    } catch (e) {
      console.warn("Supabase join org exception, trying offline:", e);
    }
  }

  const { offlineOrgs } = await getSync([STORAGE_KEYS.offlineOrgs]);
  const orgs = offlineOrgs || {};
  if (orgs[code]) {
    return { ...orgs[code], code, isOffline: true };
  }
  return null;
}

async function addOrgLink(org, linkName, url) {
  let success = false;
  if (isSupabaseAvailable() && !org.isOffline) {
    try {
      const { error } = await window.sb
        .from("organization_links")
        .insert([{ org_id: org.id, name: linkName, url }]);
      if (!error) {
        success = true;
      } else {
        console.warn("Supabase add link failed, using offline fallback:", error);
      }
    } catch (e) {
      console.warn("Supabase add link exception, using offline fallback:", e);
    }
  }

  if (!success) {
    const { offlineOrgs } = await getSync([STORAGE_KEYS.offlineOrgs]);
    const orgs = offlineOrgs || {};
    if (!orgs[org.code]) {
      orgs[org.code] = { id: org.id, name: org.name, links: [] };
    }
    orgs[org.code].links.push({ name: linkName, url });
    await setSync({ [STORAGE_KEYS.offlineOrgs]: orgs });
  }
}

function renderGroupLinksList(links) {
  const list = $("groupLinks");
  if (!list) return;

  list.innerHTML = "";

  if (!links.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No organization links found. Click Add Link to add one.";
    list.appendChild(empty);
    return;
  }

  links.forEach((item) => {
    const row = document.createElement("div");
    row.className = "item";

    const left = document.createElement("div");
    left.style.overflow = "hidden";

    const nameLink = document.createElement("a");
    nameLink.href = "#";
    nameLink.textContent = item.name || "Untitled";
    nameLink.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(item.url);
    });

    const urlSmall = document.createElement("small");
    urlSmall.textContent = item.url || "";

    left.appendChild(nameLink);
    left.appendChild(urlSmall);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const openBtn = document.createElement("button");
    openBtn.className = "icon-btn";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => openUrl(item.url));

    actions.appendChild(openBtn);
    row.appendChild(left);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function updateOrgUI(org) {
  const orgTitle = $("orgTitle");
  const createOrgBtn = $("createOrgBtn");
  const joinOrgBtn = $("joinOrgBtn");
  const leaveOrgBtn = $("leaveOrgBtn");
  const addOrgLinkBtn = $("addOrgLinkBtn");

  if (org) {
    if (orgTitle) orgTitle.textContent = `${org.name} (${org.code})`;
    if (createOrgBtn) createOrgBtn.classList.add("hidden");
    if (joinOrgBtn) joinOrgBtn.classList.add("hidden");
    if (leaveOrgBtn) leaveOrgBtn.classList.remove("hidden");
    if (addOrgLinkBtn) addOrgLinkBtn.classList.remove("hidden");

    setStatus("Loading organization links...");
    const links = await getOrgLinks(org.id, org.code);
    renderGroupLinksList(links);
    setStatus("");
  } else {
    if (orgTitle) orgTitle.textContent = "Organization Quick Links";
    if (createOrgBtn) createOrgBtn.classList.remove("hidden");
    if (joinOrgBtn) joinOrgBtn.classList.remove("hidden");
    if (leaveOrgBtn) leaveOrgBtn.classList.add("hidden");
    if (addOrgLinkBtn) addOrgLinkBtn.classList.add("hidden");

    const list = $("groupLinks");
    if (list) {
      list.innerHTML = `<div class="muted">Join or create an organization to see quick links.</div>`;
    }
  }
}

async function joinGroup() {
  const code = (prompt("Enter organization code:") || "").trim().toUpperCase();
  if (!code) return;

  setStatus("Joining organization...");
  const org = await fetchOrgByCode(code);
  if (!org) {
    const confirmMock = confirm(`Code '${code}' not found on server or locally. Create a local mock organization with this code?`);
    if (confirmMock) {
      const name = (prompt("Enter mock organization name:") || "Mock Org").trim();
      const mockId = "offline-" + Date.now();
      const { offlineOrgs } = await getSync([STORAGE_KEYS.offlineOrgs]);
      const orgs = offlineOrgs || {};
      orgs[code] = {
        id: mockId,
        name,
        links: [
          { name: "Google", url: "https://google.com" },
          { name: `${name} Guidelines`, url: "https://example.com" }
        ]
      };
      await setSync({ [STORAGE_KEYS.offlineOrgs]: orgs });

      const newOrg = { id: mockId, name, code, isOffline: true };
      await setSync({ [STORAGE_KEYS.joinedOrg]: newOrg });
      await updateOrgUI(newOrg);
      setStatus(`Joined mock organization: ${name}`);
    } else {
      setStatus("Failed to join: Organization not found.");
    }
    return;
  }

  await setSync({ [STORAGE_KEYS.joinedOrg]: org });
  await updateOrgUI(org);
  setStatus(`Joined: ${org.name}`);
}

async function createGroup() {
  const name = (prompt("Enter organization name:") || "").trim();
  if (!name) return;

  setStatus("Creating organization...");
  const code = generateOrgCode();
  const org = await createOrganization(name, code);

  await setSync({ [STORAGE_KEYS.joinedOrg]: org });
  await updateOrgUI(org);

  if (org.isOffline) {
    alert(`Created local mock organization: ${org.name}\nShare code: ${org.code}\n(Supabase offline/paused)`);
  } else {
    alert(`Created organization: ${org.name}\nShare code: ${org.code}`);
  }
  setStatus(`Joined: ${org.name}`);
}

async function leaveGroup() {
  const confirmLeave = confirm("Are you sure you want to leave this organization?");
  if (!confirmLeave) return;

  await setSync({ [STORAGE_KEYS.joinedOrg]: null });
  await updateOrgUI(null);
  setStatus("Left organization.");
}

async function addOrgLinkPrompt() {
  const { joinedOrg } = await getSync([STORAGE_KEYS.joinedOrg]);
  if (!joinedOrg) return;

  const name = (prompt("Link name?") || "").trim();
  if (!name) return;

  const rawUrl = (prompt("URL? (must start with https://)") || "").trim();
  const url = safeUrl(rawUrl);
  if (!url) {
    alert("That URL is not valid. Use https://...");
    return;
  }

  setStatus("Adding link to organization...");
  await addOrgLink(joinedOrg, name, url);
  setStatus("Link added!");

  const links = await getOrgLinks(joinedOrg.id, joinedOrg.code);
  renderGroupLinksList(links);
  setStatus("");
}

// ------------------------------
// Init
// ------------------------------
function wireEvents() {
  $("connectGoogleBtn")?.addEventListener("click", connectGoogle);
  $("logoutBtn")?.addEventListener("click", logoutGoogle);

  $("driveSearchBtn")?.addEventListener("click", openDriveSearch);
  $("driveQuery")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openDriveSearch();
  });

  $("addMyLinkBtn")?.addEventListener("click", addMyLink);

  $("createOrgBtn")?.addEventListener("click", createGroup);
  $("joinOrgBtn")?.addEventListener("click", joinGroup);
  $("leaveOrgBtn")?.addEventListener("click", leaveGroup);
  $("addOrgLinkBtn")?.addEventListener("click", addOrgLinkPrompt);

  $("tabChat")?.addEventListener("click", () => openUrl("https://chat.google.com"));
  $("tabEmail")?.addEventListener("click", () => openUrl("https://mail.google.com"));
}

async function init() {
  wireEvents();
  await loadMyLinks();

  const { joinedOrg } = await getSync([STORAGE_KEYS.joinedOrg]);
  await updateOrgUI(joinedOrg);

  await loadCalendar();
  await loadNotifications();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.notifState) {
    updateNotifUI(changes.notifState.newValue);
  }
});

init().catch((e) => {
  console.error(e);
  setStatus(e?.message || String(e));
});
