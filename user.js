const timelineEl = document.getElementById("user-timeline");
const statusLabel = document.getElementById("user-status-label");
const form = document.getElementById("user-form");
const nameInput = document.getElementById("user-name");
const emailInput = document.getElementById("user-email");
const messageInput = document.getElementById("user-message");
const identitySection = document.querySelector(".user-form__identity");
const hintText = document.querySelector(".user-form__hint");
const fileInput = document.getElementById("user-file-input");
const attachmentPreview = document.getElementById("user-attachment-preview");

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB
const CHAT_ID_STORAGE_KEY = "support_inbox_chat_id";
const notificationAudio = new Audio("notification/notification.mp3");
notificationAudio.preload = "auto";

let socket = null;
let activeConversation = null;
let pendingAttachments = [];
let isComposerEnabled = true;


function updateIdentityVisibility() {
  if (!identitySection) return;
  const hasChat = !!activeConversation;
  identitySection.hidden = hasChat;
  identitySection.style.display = hasChat ? 'none' : '';
  if (hintText) {
    hintText.hidden = hasChat;
    hintText.style.display = hasChat ? 'none' : '';
  }
}
init();

function init() {
  setupForm();
  setupFileUploads();
  initSocket();
  render();
}

function setupForm() {
  form.addEventListener("submit", onSubmitMessage);
  messageInput.addEventListener("input", autoResizeTextarea);
}

function setupFileUploads() {
  fileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        alert(`${file.name} exceeds the 5MB limit.`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        pendingAttachments.push({
          id: generateId(),
          name: file.name,
          size: file.size,
          friendlySize: formatFileSize(file.size),
          type: file.type,
          extension: extractExtension(file.name),
          dataUrl,
        });
      } catch (error) {
        console.error("Unable to attach file", error);
      }
    }
    fileInput.value = "";
    renderAttachmentPreview();
  });
}

function initSocket() {
  const LOCAL_DEV_HOSTS = ["localhost", "127.0.0.1"];
  const isLocalEnv =
    LOCAL_DEV_HOSTS.includes(location.hostname) ||
    /^192\.168\./.test(location.hostname) ||
    location.hostname.endsWith(".local");
  const baseUrl = (window.SUPPORT_SOCKET_URL || "").trim() || (isLocalEnv ? `${location.protocol}//${location.hostname}:3100` : "");

  socket = io(baseUrl, { query: { role: "visitor" } });

  socket.on("connect", handleConnect);
  socket.on("connect_error", (err) => updateStatusLabel(`Connection issue: ${err.message}`));
  socket.on("disconnect", () => updateStatusLabel("Disconnected. Attempting to reconnect..."));

  socket.on("chat:init", handleChatInit);
  socket.on("chat:message", ({ chatId, message }) => {
    if (!activeConversation || chatId !== activeConversation.id) return;
    appendMessage(message);
    if (message.sender === "agent") {
      playNotificationSound();
    }
  });

  socket.on("chat:updated", (chat) => {
    if (!activeConversation || chat.id !== activeConversation.id) return;
    activeConversation = {
      ...activeConversation,
      ...chat,
      messages: activeConversation.messages,
    };
    applyComposerState();
    renderStatus();
  });

  socket.on("chat:deleted", ({ chatId }) => {
    if (activeConversation && activeConversation.id === chatId) {
      activeConversation = null;
      localStorage.removeItem(CHAT_ID_STORAGE_KEY);
      render();
      updateStatusLabel("Chat ended by support team.");
    }
  });
}

function handleConnect() {
  updateStatusLabel("Connected to support");
  const storedChatId = localStorage.getItem(CHAT_ID_STORAGE_KEY);
  socket.emit("visitor:init", {
    chatId: storedChatId || null,
    name: nameInput.value.trim() || null,
    email: emailInput.value.trim() || null,
  });
}

function handleChatInit(chat) {
  activeConversation = {
    ...chat,
    messages: Array.isArray(chat.messages) ? chat.messages.slice() : [],
  };
  if (chat.id) {
    localStorage.setItem(CHAT_ID_STORAGE_KEY, chat.id);
  }
  if (chat.visitorName && nameInput.value.trim() === "") {
    nameInput.value = chat.visitorName;
  }
  if (chat.visitorEmail && emailInput.value.trim() === "") {
    emailInput.value = chat.visitorEmail;
  }
  applyComposerState();
  render();
  updateIdentityVisibility();
  updateIdentityVisibility();
}

function onSubmitMessage(event) {
  event.preventDefault();
  if (!socket || !socket.connected || !activeConversation) return;

  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  if (name && name !== activeConversation.visitorName) {
    socket.emit("visitor:update-name", { chatId: activeConversation.id, name });
  }
  if (email && email !== activeConversation.visitorEmail) {
    socket.emit("visitor:update-name", { chatId: activeConversation.id, email });
  }

  const text = messageInput.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  socket.emit("visitor:message", {
    chatId: activeConversation.id,
    body: text,
    attachments: pendingAttachments.map((file) => ({
      id: file.id,
      name: file.name,
      size: file.size,
      friendlySize: file.friendlySize,
      type: file.type,
      extension: file.extension,
      dataUrl: file.dataUrl,
    })),
  });

  messageInput.value = "";
  autoResizeTextarea();
  pendingAttachments = [];
  renderAttachmentPreview();
  updateIdentityVisibility();
}

function appendMessage(message) {
  activeConversation.messages.push(message);
  renderTimeline();
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

  const messages = activeConversation.messages || [];
  messages
    .slice()
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .forEach((message) => {
      const wrapper = document.createElement("div");
      wrapper.className = "user-message";
      if (message.sender === "agent") {
        wrapper.classList.add("user-message--agent");
      } else if (message.sender === "visitor") {
        wrapper.classList.add("user-message--customer");
      } else {
        wrapper.classList.add("user-message--system");
      }

      if (message.sender !== "system") {
        const meta = document.createElement("div");
        meta.className = "message-meta";
        if (message.sender === "visitor") meta.classList.add("message-meta--right");
        const senderLabel = message.sender === "agent" ? (message.name || "Support") : "You";
        meta.innerHTML = `<span>${senderLabel}</span><span>${formatMessageTimestamp(message.ts)}</span>`;
        wrapper.appendChild(meta);
      }

      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      if (message.sender === "agent") {
        bubble.classList.add("message-bubble--agent");
      } else if (message.sender === "visitor") {
        bubble.classList.add("message-bubble--user");
      } else {
        bubble.classList.add("message-bubble--system");
      }
      bubble.textContent = message.text || (message.attachments && message.attachments.length ? "Sent attachments" : "");
      wrapper.appendChild(bubble);

      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        const list = document.createElement("div");
        list.className = "message-attachments";
        message.attachments.forEach((file) => {
          const link = document.createElement("a");
          link.className = "message-attachment";
          link.href = file.dataUrl;
          link.download = file.name;
          link.target = "_blank";
          link.rel = "noopener";

          if (file.type && file.type.startsWith("image/")) {
            const thumb = document.createElement("img");
            thumb.className = "message-attachment__thumb";
            thumb.src = file.dataUrl;
            thumb.alt = file.name;
            link.appendChild(thumb);
          } else {
            const placeholder = document.createElement("div");
            placeholder.className = "message-attachment__thumb";
            placeholder.textContent = (file.extension || "FILE").slice(0, 4);
            placeholder.style.display = "flex";
            placeholder.style.alignItems = "center";
            placeholder.style.justifyContent = "center";
            placeholder.style.fontSize = "0.7rem";
            placeholder.style.color = "rgba(255,255,255,0.7)";
            link.appendChild(placeholder);
          }

          const meta = document.createElement("div");
          meta.className = "message-attachment__meta";
          const nameEl = document.createElement("strong");
          nameEl.textContent = file.name;
          const sizeEl = document.createElement("span");
          sizeEl.textContent = file.friendlySize || formatFileSize(file.size || 0);
          meta.appendChild(nameEl);
          meta.appendChild(sizeEl);
          link.appendChild(meta);

          list.appendChild(link);
        });
        wrapper.appendChild(list);
      }

      timelineEl.appendChild(wrapper);
    });

  timelineEl.scrollTop = timelineEl.scrollHeight;
}

function renderStatus() {
  if (!activeConversation) {
    statusLabel.textContent = "Waiting to connect...";
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
  const disabled = !isComposerEnabled;
  messageInput.disabled = disabled;
  fileInput.disabled = disabled;
  form.querySelector(".user-send").disabled = disabled;
  updateIdentityVisibility();
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
    removeBtn.textContent = "×";
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


function formatMessageTimestamp(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
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
  } catch (_) {}
}
