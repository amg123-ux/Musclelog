// Supabase Edge Function: admin-users
// Deploy with: supabase functions deploy admin-users
// Required secret: SUPABASE_SERVICE_ROLE_KEY (Supabase provides this to Edge Functions).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Требуется авторизация" }, 401);

    const adminClient = createClient(url, serviceKey);
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !user) return json({ error: "Недействительная сессия" }, 401);

    const { data: profile } = await adminClient
      .from("profiles").select("role,is_active").eq("id", user.id).maybeSingle();
    if (!profile || profile.role !== "admin" || !profile.is_active) {
      return json({ error: "Недостаточно прав" }, 403);
    }

    const body = await req.json();
    if (body.action === "list") {
      const { data: authUsers, error } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const { data: profiles, error: pError } = await adminClient
        .from("profiles").select("id,email,role,is_active,created_at");
      if (pError) throw pError;
      const byId = new Map((profiles || []).map((p) => [p.id, p]));
      return json((authUsers.users || []).map((u) => ({
        id: u.id, email: u.email, created_at: u.created_at,
        role: byId.get(u.id)?.role || "user",
        is_active: byId.get(u.id)?.is_active ?? true,
      })));
    }

    if (body.action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Проверь электронную почту" }, 400);
      const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
        redirectTo: body.redirectTo || undefined,
      });
      if (error) throw error;
      return json({ success: true, user_id: data.user?.id });
    }

    if (body.action === "set_active") {
      const userId = String(body.user_id || "");
      const active = Boolean(body.active);
      if (!userId || userId === user.id) return json({ error: "Нельзя изменить собственный доступ" }, 400);
      const { error: profileError } = await adminClient.from("profiles")
        .update({ is_active: active }).eq("id", userId);
      if (profileError) throw profileError;
      const { error: authError } = await adminClient.auth.admin.updateUserById(userId, {
        ban_duration: active ? "none" : "876000h",
      });
      if (authError) throw authError;
      return json({ success: true });
    }

    return json({ error: "Неизвестная операция" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Внутренняя ошибка" }, 500);
  }
});
