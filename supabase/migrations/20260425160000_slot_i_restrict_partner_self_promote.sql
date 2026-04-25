-- =============================================
-- Slot I — Rol-gebaseerd partner-team
-- =============================================
-- Voorkomt dat een partner-medewerker (manage_users=false) zichzelf of een
-- collega kan promoveren tot manage_users=true via een PATCH op user_roles.
-- Voorheen liet `user_roles_partner_update` (WITH CHECK) elke permissions-
-- mutatie toe zolang manage_partners=false bleef en role!='admin'.
--
-- Defense-in-depth: dit is dubbele bescherming naast de edge functions
-- `invite-partner-member` en `remove-partner-member` die server-side
-- de toegestane permissie-keys whitelist'en. Als een partner via REST/JS
-- een directe PATCH op user_roles probeert te doen, blokkeert deze policy.
--
-- Mechaniek: vervang user_roles_partner_update door een variant met een
-- WITH CHECK clause die `permissions->>'manage_users'` vergelijkt met de
-- HUIDIGE waarde voor diezelfde rij; alleen partner-admins met manage_users
-- mogen die flag wijzigen op andermans rij. Een gebruiker mag zijn EIGEN
-- manage_users-flag nooit aanpassen (anti-self-promote, ook owners).
-- =============================================

-- Helper: huidige waarde van permissions.manage_users voor een user_roles-rij.
-- Stable + security definer zodat de subquery binnen de policy efficient draait.
CREATE OR REPLACE FUNCTION public.user_role_has_manage_users(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((ur.permissions->>'manage_users')::boolean, false)
  FROM public.user_roles ur
  WHERE ur.user_id = p_user_id
$$;

COMMENT ON FUNCTION public.user_role_has_manage_users(uuid) IS
  'Slot I — Stable lookup of user_roles.permissions.manage_users used by RLS WITH CHECK clauses to prevent partner self-promotion.';

REVOKE ALL ON FUNCTION public.user_role_has_manage_users(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_role_has_manage_users(uuid) TO authenticated;

-- Helper: caller is partner-admin (role='partner', has manage_users) for a partner_id.
CREATE OR REPLACE FUNCTION public.is_partner_admin_of(p_partner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = (SELECT auth.uid())
      AND ur.role = 'partner'
      AND ur.partner_id = p_partner_id
      AND COALESCE((ur.permissions->>'manage_users')::boolean, false) = true
  )
$$;

COMMENT ON FUNCTION public.is_partner_admin_of(uuid) IS
  'Slot I — TRUE iff caller has role=partner + matching partner_id + permissions.manage_users=true. Used by RLS to gate sensitive permission mutations.';

REVOKE ALL ON FUNCTION public.is_partner_admin_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_partner_admin_of(uuid) TO authenticated;

-- Vervang user_roles_partner_update met self-promote-blok.
DROP POLICY IF EXISTS user_roles_partner_update ON public.user_roles;
CREATE POLICY user_roles_partner_update ON public.user_roles
  FOR UPDATE TO authenticated
  USING (
    partner_id IS NOT NULL
    AND is_partner_of(partner_id)
    AND role <> 'admin'
  )
  WITH CHECK (
    is_partner_of(partner_id)
    AND role <> 'admin'
    -- manage_partners blijft eeuwig false voor partner-tenant-tak.
    AND COALESCE((permissions->>'manage_partners')::boolean, false) = false
    -- manage_pricing mag niet via deze tak gezet worden (server-side via dedicated UI).
    AND COALESCE((permissions->>'manage_pricing')::boolean, false) = false
    AND (
      -- Twee toegestane scenarios voor een UPDATE die manage_users wijzigt:
      --   1) De wijziging laat manage_users ongewijzigd (vergelijking met huidige waarde)
      --   2) De caller is partner-admin (manage_users=true) van dezelfde partner_id
      --      EN wijzigt NIET zijn eigen rij (anti-self-promote/demote).
      COALESCE((permissions->>'manage_users')::boolean, false) = user_role_has_manage_users(user_id)
      OR (
        is_partner_admin_of(partner_id)
        AND user_id <> (SELECT auth.uid())
      )
    )
  );

COMMENT ON POLICY user_roles_partner_update ON public.user_roles IS
  'Slot I — Partner mag eigen team-permissions toggelen, maar (a) nooit manage_partners/manage_pricing aanzetten, (b) nooit eigen rij promoten/demoten op manage_users, (c) manage_users-flag enkel wijzigbaar door bestaande partner-admin van dezelfde tenant.';
