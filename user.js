import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  updateDoc,
  addDoc,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const timelineEl = document.getElementById("user-timeline");
const statusLabel = document.getElementById("user-status-label");
const form = document.getElementById("user-form");
const nameInput = document.getElementById("user-name");
const emailInput = document.getElementById("user-email");
const messageInput = document.getElementById("user-message");
const sendButton = form.querySelector(".user-send");
const identitySection = document.querySelector(".user-form__identity");
const hintText = document.querySelector(".user-form__hint");
const fileInput = document.getElementById("user-file-input");
const attachmentPreview = document.getElementById("user-attachment-preview");

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB
const CHAT_ID_STORAGE_KEY = "support_inbox_chat_id";
const notificationAudio = new Audio("notification/notification.mp3");
notificationAudio.preload = "auto";

let db = null;
let storage = null;
let activeConversation = null;
let pendingAttachments = [];
let isComposerEnabled = true;
let isSendingMessage = false;
let chatRef = null;
let chatUnsubscribe = null;
let messagesUnsubscribe = null;
let messagesReady = false;
let pendingChatPromise = null;

init();

function init() {
  if (!window.FIREBASE_CONFIG) {
    updateStatusLabel("Chat temporarily unavailable. Please reload later.");
    console.error("Missing Firebase configuration");
    return;
  }

  const app = initializeApp(window.FIREBASE_CONFIG);
  db = getFirestore(app);
  storage = getStorage(app);

  setupForm();
  setupFileUploads();
  restoreExistingChat();
  render();
}

function setupForm() {
  form.addEventListener("submit", onSubmitMessage);
  messageInput.addEventListener("input", autoResizeTextarea);
}

function setupFileUploads() {
  fileInput.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        alert(`${file.name} exceeds the 5MB limit.`);
        continue;
      }
      pendingAttachments.push({
        id: generateId(),
        file,
        name: file.name,
        size: file.size,
        friendlySize: formatFileSize(file.size),
        type: file.type,
        extension: extractExtension(file.name),
      });
    }
    fileInput.value = "";
    renderAttachmentPreview();
  });
}

function restoreExistingChat() {
  const storedChatId = localStorage.getItem(CHAT_ID_STORAGE_KEY);
  if (storedChatId) {
    subscribeToChat(storedChatId);
  } else {
    updateStatusLabel("Start a message and our team will reply here.");
  }
}

async function onSubmitMessage(event) {
  event.preventDefault();
  if (!db || isSendingMessage) return;

  const text = messageInput.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  const name = nameInput.value.trim();
  const email = emailInput.value.trim();

  try {
    isSendingMessage = true;
    applyComposerState();

    const chatId = await ensureChat(name, email);
    await maybeUpdateVisitorDetails(chatId, name, email);

    const attachments = await uploadPendingAttachments(chatId);
    const ts = serverTimestamp();
    await addDoc(collection(chatRef, "messages"), {
      sender: "visitor",
      text,
      attachments,
      ts,
    });

    const preview =
      text ||
      (attachments.length
        ? `${attachments.length} file${attachments.length > 1 ? "s" : ""}`
        : "Message");

    await updateDoc(chatRef, {
      updatedAt: ts,
      lastMessagePreview: preview,
      lastMessageSender: "visitor",
      lastMessageTs: ts,
    });

    await logActivity(
      chatId,
      text ? "Visitor message" : "Visitor shared files",
      text ? text.slice(0, 120) : attachments.map((file) => file.name).join(", ")
    );

    messageInput.value = "";
    autoResizeTextarea();
    pendingAttachments = [];
    renderAttachmentPreview();
    updateIdentityVisibility();
  } catch (error) {
    console.error("Failed to send visitor message", error);
    alert("Unable to send your message right now. Please try again.");
  } finally {
    isSendingMessage = false;
    applyComposerState();
  }
}

async function ensureChat(name, email) {
  if (activeConversation && activeConversation.id) {
    return activeConversation.id;
  }
  if (pendingChatPromise) {
    return pendingChatPromise;
  }
  pendingChatPromise = createChat(name, email)
    .then((id) => {
      pendingChatPromise = null;
      return id;
    })
    .catch((error) => {
      pendingChatPromise = null;
      throw error;
    });
  return pendingChatPromise;
}

async function createChat(name, email) {
  const chatDocRef = doc(collection(db, "chats"));
  const ts = serverTimestamp();
  await setDoc(chatDocRef, {
    visitorName: name || null,
    visitorEmail: email || null,
    status: "open",
    allowUploads: true,
    agentNote: "",
    followUp: null,
    channel: "Web chat",
    priority: "normal",
    assignedTo: "Unassigned",
    lastMessagePreview: "",
    lastMessageSender: "",
    createdAt: ts,
    updatedAt: ts,
  });

  const chatId = chatDocRef.id;
  localStorage.setItem(CHAT_ID_STORAGE_KEY, chatId);

  activeConversation = {
    id: chatId,
    visitorName: name || "",
    visitorEmail: email || "",
    status: "open",
    allowUploads: true,
    messages: [],
  };

  subscribeToChat(chatId);
  await logActivity(chatId, "Chat started", name ? `Visitor: ${name}` : "New visitor");
  updateStatusLabel("Connected to support");
  return chatId;
}

function subscribeToChat(chatId) {
  if (chatUnsubscribe) {
    chatUnsubscribe();
    chatUnsubscribe = null;
  }
  if (messagesUnsubscribe) {
    messagesUnsubscribe();
    messagesUnsubscribe = null;
  }

  chatRef = doc(db, "chats", chatId);
  messagesReady = false;

  chatUnsubscribe = onSnapshot(
    chatRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        handleChatClosed();
        return;
      }
      const data = snapshot.data();
      activeConversation = {
        ...(activeConversation || { id: chatId, messages: [] }),
        id: chatId,
        visitorName: data.visitorName || "",
        visitorEmail: data.visitorEmail || "",
        status: data.status || "open",
        allowUploads: data.allowUploads !== false,
        createdAt: toMillis(data.createdAt),
        updatedAt: toMillis(data.updatedAt),
      };
      renderStatus();
      applyComposerState();
      updateIdentityVisibility();
    },
    (error) => {
      console.error("Chat subscription error", error);
      updateStatusLabel("Connection issue. Retrying…");
    }
  );

  const messagesQuery = query(
    collection(chatRef, "messages"),
    orderBy("ts", "asc")
  );

  messagesUnsubscribe = onSnapshot(
    messagesQuery,
    (snapshot) => {
      const messages = snapshot.docs.map((docSnap) => {
        const messageData = docSnap.data();
        return {
          id: docSnap.id,
          sender: messageData.sender || "system",
          text: messageData.text || "",
          attachments: Array.isArray(messageData.attachments)
            ? messageData.attachments.map((file) => ({
                ...file,
                friendlySize: file.friendlySize || formatFileSize(file.size || 0),
              }))
            : [],
          ts: toMillis(messageData.ts),
        };
      });

      if (messagesReady) {
        snapshot.docChanges().forEach((change) => {
          if (
            change.type === "added" &&
            change.doc.data().sender === "agent"
          ) {
            playNotificationSound();
          }
        });
      }

      messagesReady = true;
      activeConversation = {
        ...(activeConversation || { id: chatId }),
        id: chatId,
        messages,
      };
      renderTimeline();
    },
    (error) => console.error("Messages subscription error", error)
  );
}

async function maybeUpdateVisitorDetails(chatId, name, email) {
  if (!chatRef || !activeConversation) return;
  const updates = {};
  const nameChanged =
    (name && name !== activeConversation.visitorName) ||
    (!name && activeConversation.visitorName);
  const emailChanged =
    (email && email !== activeConversation.visitorEmail) ||
    (!email && activeConversation.visitorEmail);

  if (nameChanged) {
    updates.visitorName = name || null;
  }
  if (emailChanged) {
    updates.visitorEmail = email || null;
  }

  if (Object.keys(updates).length === 0) return;

  updates.updatedAt = serverTimestamp();
  try {
    await updateDoc(chatRef, updates);
    await logActivity(
      chatId,
      "Visitor details updated",
      `${name || "Guest"}${email ? ` • ${email}` : ""}`
    );
  } catch (error) {
    console.error("Unable to update visitor profile", error);
  }
}

async function uploadPendingAttachments(chatId) {
  if (!pendingAttachments.length) return [];
  const uploads = [];

  for (const attachment of pendingAttachments) {
    const safeName = sanitizeFileName(attachment.name);
    const path = `chats/${chatId}/visitor/${Date.now()}_${attachment.id}_${safeName}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, attachment.file, {
      contentType: attachment.type || "application/octet-stream",
    });
    const url = await getDownloadURL(fileRef);
    uploads.push({
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      friendlySize: attachment.friendlySize,
      type: attachment.type,
      extension: attachment.extension,
      url,
      storagePath: path,
    });
  }

  return uploads;
}

async function logActivity(chatId, title, detail) {
  try {
    await addDoc(collection(doc(db, "chats", chatId), "activity"), {
      title,
      detail: detail || "",
      ts: serverTimestamp(),
    });
  } catch (error) {
    console.warn("Unable to record activity", error);
  }
}

function handleChatClosed() {
  if (ChatIdExists()) {
    updateStatusLabel("Chat ended by support team.");
  } else {
    updateStatusLabel("Conversation unavailable. Please start a new chat.");
  }
  localStorage.removeItem(CHAT_ID_STORAGE_KEY);
  activeConversation = null;
  if (chatUnsubscribe) {
    chatUnsubscribe();
    chatUnsubscribe = null;
  }
  if (messagesUnsubscribe) {
    messagesUnsubscribe();
    messagesUnsubscribe = null;
  }
  render();
}

function ChatIdExists() {
  return !!(activeConversation && activeConversation.id);
}

function render() {
  renderTimeline();
  renderStatus();
  renderAttachmentPreview();
  applyComposerState();
  updateIdentityVisibility();
}

function renderTimeline() {
  timelineEl.innerHTML = "";

  if (!activeConversation) {
    const welcome = document.createElement("div");
    welcome.className = "message-bubble message-bubble--system";
    welcome.textContent = "Start a chat and an agent will join shortly.";
    timelineEl.appendChild(welcome);
    return;
  }

  const messages = Array.isArray(activeConversation.messages)
    ? activeConversation.messages
    : [];

  messages.forEach((message) => {
    const wrapper = document.createElement("div");
    wrapper.className = "user-message";
    if (message.sender === "agent") {
      wrapper.classList.add("user-message--agent");
    } else if (message.sender === "visitor") {
      wrapper.classList.add("user-message--customer");
    } else {
      wrapper.classList.add("user-message--system");
    }

    const bubble = document.createElement("div");
    bubble.className = "user-message__bubble";

    if (message.text) {
      const textEl = document.createElement("p");
      textEl.textContent = message.text;
      bubble.appendChild(textEl);
    }

    if (Array.isArray(message.attachments) && message.attachments.length) {
      const list = document.createElement("div");
      list.className = "user-message__attachments";
      message.attachments.forEach((file) => {
        const link = document.createElement("a");
        link.className = "user-attachment";
        link.href = file.url || file.dataUrl || "#";
        link.download = file.name;
        link.target = "_blank";
        link.rel = "noopener";

        if ((file.type || "").startsWith("image/") && (file.url || file.dataUrl)) {
          const img = document.createElement("img");
          img.src = file.url || file.dataUrl;
          img.alt = file.name;
          link.appendChild(img);
        } else {
          const badge = document.createElement("span");
          badge.className = "user-attachment__badge";
          badge.textContent = (file.extension || "FILE").slice(0, 4);
          link.appendChild(badge);
        }

        const meta = document.createElement("div");
        meta.className = "user-attachment__meta";
        const sizeLabel =
          file.friendlySize || formatFileSize(file.size || 0);
        meta.innerHTML = `<strong>${file.name}</strong><span>${sizeLabel}</span>`;
        link.appendChild(meta);
        list.appendChild(link);
      });
      bubble.appendChild(list);
    }

    const meta = document.createElement("footer");
    meta.className = "user-message__meta";
    meta.textContent = formatMessageTimestamp(message.ts);
    bubble.appendChild(meta);

    wrapper.appendChild(bubble);
    timelineEl.appendChild(wrapper);
  });

  timelineEl.scrollTop = timelineEl.scrollHeight;
}

function renderStatus() {
  if (!activeConversation) {
    statusLabel.textContent = "Waiting to connect…";
    return;
  }

  if (activeConversation.status === "closed") {
    statusLabel.textContent = "Chat closed. Start a new message to reopen.";
  } else {
    statusLabel.textContent = "Connected to 22Bet Support.";
  }
}

function applyComposerState() {
  const isClosed = activeConversation && activeConversation.status === "closed";
  isComposerEnabled = !isClosed;
  const disabled = !isComposerEnabled || isSendingMessage;
  messageInput.disabled = disabled;
  fileInput.disabled = disabled;
  sendButton.disabled = disabled;
}

function renderAttachmentPreview() {
  attachmentPreview.innerHTML = "";
  if (pendingAttachments.length === 0) {
    attachmentPreview.hidden = true;
    return;
  }

  pendingAttachments.forEach((file) => {
    const chip = document.createElement("span");
    chip.className = "user-attachment-chip";
    chip.textContent = `${file.name} (${file.friendlySize})`;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", `Remove ${file.name}`);
    removeBtn.textContent = "x";
    removeBtn.addEventListener("click", () => {
      pendingAttachments = pendingAttachments.filter((item) => item.id !== file.id);
      renderAttachmentPreview();
    });

    chip.appendChild(removeBtn);
    attachmentPreview.appendChild(chip);
  });

  attachmentPreview.hidden = false;
}

function updateStatusLabel(text) {
  statusLabel.textContent = text;
}

function autoResizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

function updateIdentityVisibility() {
  if (!identitySection) return;
  const hasChat = !!(activeConversation && activeConversation.id);
  identitySection.hidden = hasChat;
  identitySection.style.display = hasChat ? "none" : "";
  if (hintText) {
    hintText.hidden = hasChat;
    hintText.style.display = hasChat ? "none" : "";
  }
}

function formatMessageTimestamp(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatFileSize(size) {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${size} B`;
}

function extractExtension(name) {
  const parts = name.split(".");
  const ext = parts.length > 1 ? parts.pop().toUpperCase() : "FILE";
  return ext.length > 4 ? ext.slice(0, 4) : ext;
}

function generateId() {
  return `att_${Math.random().toString(16).slice(2, 10)}`;
}

function playNotificationSound() {
  try {
    notificationAudio.currentTime = 0;
    notificationAudio.play().catch(() => {});
  } catch (_) {
    // Ignore autoplay errors in browsers that block audio.
  }
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toMillis(value) {
  if (!value) return Date.now();
  if (typeof value.toMillis === "function") return value.toMillis();
  return Number(value) || Date.now();
}
