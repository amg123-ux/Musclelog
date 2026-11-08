(() => {
  const SUPABASE_URL = "https://lgnohmcyizwkyzwtmuhc.supabase.co";
  const SUPABASE_KEY = "sb_publishable_fDWYHagDC-3BTM4Nay5V5A_OpIPbN6s";
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  let currentUser = null, currentProfile = null, saveTimer = null, started = false, sessionVersion = 0, saveQueue = Promise.resolve();

  const el = id => document.getElementById(id);
  const showError = msg => { if (el("authError")) el("authError").textContent = msg || ""; };
  const showApp = yes => document.body.classList.toggle("locked", !yes);
  const safe = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const emailRedirect = () => location.origin + location.pathname;

  async function publishProgress(userId, snapshot, version = sessionVersion) {
    const progress = {
      workouts: Array.isArray(snapshot.workouts) ? snapshot.workouts : [],
      measures: Array.isArray(snapshot.measures) ? snapshot.measures : []
    };
    const { error: writeError } = await client.from("shared_progress").upsert({
      user_id: userId, progress, updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (writeError) {
      console.error("MuscleLog shared progress sync failed:", writeError.message);
      window.ML?.setSharedProgress?.([], "Не удалось загрузить общий прогресс. Проверьте настройку Supabase.");
      return;
    }
    const { data, error } = await client.from("shared_progress")
      .select("user_id,progress,updated_at").order("updated_at", { ascending: false });
    if (error) {
      console.error("MuscleLog shared progress load failed:", error.message);
      window.ML?.setSharedProgress?.([], "Не удалось загрузить общий прогресс. Проверьте настройку Supabase.");
      return;
    }
    if (version === sessionVersion && currentUser?.id === userId) {
      window.ML?.setSharedProgress?.(data || []);
    }
  }

  async function handleSession(session) {
    const version = ++sessionVersion;
    if (!session?.user) {
      currentUser = null; currentProfile = null;
      clearTimeout(saveTimer);
      showApp(false);
      return;
    }
    const user = session.user;
    currentUser = user;
    showError("");
    showApp(false);
    const { data: profile, error } = await client.from("profiles")
      .select("id,email,role,is_active").eq("id", user.id).maybeSingle();
    if (version !== sessionVersion) return;
    if (error) { showError("Не удалось проверить профиль: " + error.message); await client.auth.signOut(); return; }
    if (!profile || !profile.is_active) {
      showError("Доступ к MuscleLog отключён. Обратитесь к администратору.");
      await client.auth.signOut(); return;
    }
    const { data, error: dataError } = await client.from("user_data")
      .select("data").eq("user_id", user.id).maybeSingle();
    if (version !== sessionVersion) return;
    if (dataError) { showError("Не удалось загрузить ваши данные: " + dataError.message); return; }
    currentProfile = profile;
    const savedData = data?.data || {};
    window.ML.setData(savedData);
    const needsDefaults = !savedData.profile || !("age" in savedData.profile) ||
      !("height" in savedData.profile) || !("sex" in savedData.profile) ||
      !savedData.goals || !("kcal" in savedData.goals) || !Array.isArray(savedData.plan);
    if (needsDefaults) save(window.ML.getData());
    await publishProgress(user.id, window.ML.getData(), version);
    if (version !== sessionVersion) return;
    showApp(true);
    const adminTab = el("adminTab");
    if (adminTab) adminTab.classList.toggle("adminOnly", profile.role !== "admin");
    const signOut = el("signOut");
    if (signOut) signOut.onclick = async () => { await client.auth.signOut(); };
    if (profile.role === "admin") refreshUsers();
  }

  async function adminCall(body) {
    const { data: { session } } = await client.auth.getSession();
    const { data, error } = await client.functions.invoke("admin-users", {
      body, headers: { Authorization: "Bearer " + session.access_token }
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function refreshUsers() {
    const target = el("userList");
    if (!target || currentProfile?.role !== "admin") return;
    target.innerHTML = '<div class="empty">Загрузка пользователей...</div>';
    try {
      const users = await adminCall({ action: "list" });
      target.innerHTML = users.map(u => {
        const self = u.id === currentUser.id;
        const active = u.is_active;
        return '<div class="item"><div class="row"><div style="min-width:0"><b style="overflow-wrap:anywhere">' + safe(u.email || "Без почты") + '</b><p>' +
          (u.role === "admin" ? "Администратор" : "Пользователь") + " · " + (active ? "Активен" : "Заблокирован") +
          '</p></div>' + (self ? '<span class="mint">Это вы</span>' :
          '<button class="btn secondary" data-user="' + safe(u.id) + '" data-active="' + (!active) + '">' +
          (active ? "Заблокировать" : "Разблокировать") + '</button>') + '</div></div>';
      }).join("") || '<div class="empty">Пользователей пока нет</div>';
      target.querySelectorAll("button[data-user]").forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try {
          await adminCall({ action: "set_active", user_id: btn.dataset.user, active: btn.dataset.active === "true" });
          await refreshUsers();
        } catch (e) { alert("Не удалось изменить доступ: " + e.message); btn.disabled = false; }
      });
    } catch (e) {
      target.innerHTML = '<div class="empty">Ошибка загрузки: ' + safe(e.message) + '</div>';
    }
  }

  function init() {
    if (started) return; started = true;
    showApp(false);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (hash.get("type") === "invite" || hash.get("type") === "recovery") {
      el("authTitle").textContent = "Создание пароля";
      el("authHint").textContent = "Придумайте пароль для своего аккаунта.";
      el("loginForm").style.display = "none";
      el("passwordForm").style.display = "block";
    }
    el("loginForm").addEventListener("submit", async e => {
      e.preventDefault(); showError("");
      const btn = el("authSubmit"); btn.disabled = true; btn.textContent = "Входим...";
      const { error } = await client.auth.signInWithPassword({
        email: el("authEmail").value.trim(), password: el("authPassword").value
      });
      if (error) showError(error.message === "Invalid login credentials" ? "Неверная почта или пароль." : error.message);
      btn.disabled = false; btn.textContent = "Войти";
    });
    el("passwordForm").addEventListener("submit", async e => {
      e.preventDefault(); showError("");
      const password = el("newPassword").value;
      if (password.length < 8) return showError("Пароль должен содержать минимум 8 символов.");
      const { error } = await client.auth.updateUser({ password });
      if (error) return showError(error.message);
      history.replaceState(null, "", location.pathname + location.search);
      el("passwordForm").style.display = "none"; el("loginForm").style.display = "block";
      el("authTitle").textContent = "Пароль сохранён";
      el("authHint").textContent = "Теперь войдите с новой почтой и паролем.";
      showError("Пароль успешно создан. Войдите в приложение.");
      await client.auth.signOut();
    });
    el("inviteForm").addEventListener("submit", async e => {
      e.preventDefault();
      const btn = e.submitter; btn.disabled = true; btn.textContent = "Отправляем...";
      try {
        await adminCall({ action: "invite", email: el("inviteEmail").value.trim(), redirectTo: emailRedirect() });
        el("inviteEmail").value = "";
        alert("Приглашение отправлено. Попросите пользователя проверить почту.");
        await refreshUsers();
      } catch (err) { alert("Ошибка: " + err.message); }
      btn.disabled = false; btn.textContent = "Отправить приглашение";
    });
    el("refreshUsers").onclick = refreshUsers;
    document.querySelectorAll('nav button[data-tab="admin"]').forEach(b => b.onclick = () => {
      if (currentProfile?.role !== "admin") return;
      window.ML.go("admin"); refreshUsers();
      document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
    });
    client.auth.onAuthStateChange((event, session) => {
      if ((event === "TOKEN_REFRESHED" || event === "USER_UPDATED") && currentUser?.id === session?.user?.id) return;
      // Defer Supabase requests until after the auth callback returns.
      setTimeout(() => handleSession(session).catch(e => showError("Ошибка загрузки профиля: " + e.message)), 0);
    });
  }

  function save(data) {
    if (!currentUser || !currentProfile?.is_active) return;
    clearTimeout(saveTimer);
    const userId = currentUser.id;
    const snapshot = JSON.parse(JSON.stringify(data));
    saveTimer = setTimeout(() => {
      saveQueue = saveQueue.then(async () => {
        if (currentUser?.id !== userId) return;
        const { error } = await client.from("user_data").upsert({
          user_id: userId, data: snapshot, updated_at: new Date().toISOString()
        }, { onConflict: "user_id" });
        if (error) {
          console.error("MuscleLog cloud save failed:", error.message);
          window.ML?.notify?.("Не удалось сохранить данные. Проверьте соединение.");
          return;
        }
        await publishProgress(userId, snapshot, sessionVersion);
      }).catch(error => {
        console.error("MuscleLog cloud save failed:", error.message);
        window.ML?.notify?.("Не удалось сохранить данные. Проверьте соединение.");
      });
    }, 500);
  }

  window.MuscleAuth = { init, save };
})();