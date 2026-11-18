-- Correct level progression parity: calculateLevelProgress derives level from total XP.
create or replace function nexora.claim_daily_stipend(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = nexora, pg_temp
as $$
declare
  v_date date := (now() at time zone 'UTC')::date;
  v_amount integer;
  v_finance integer;
  v_xp bigint;
  v_next_xp bigint;
  v_level integer;
  v_next_level integer;
  v_skill_points integer;
  v_leadership numeric;
  v_claim_id text;
  v_tx_id text;
  v_notification_id text;
begin
  if p_user_id is null or length(p_user_id) < 1 then raise exception 'UNAUTHENTICATED'; end if;
  v_claim_id := p_user_id || '_' || to_char(v_date, 'YYYY-MM-DD');
  v_tx_id := 'daily_' || p_user_id || '_' || to_char(v_date, 'YYYY-MM-DD');
  v_notification_id := 'daily_' || p_user_id || '_' || to_char(v_date, 'YYYY-MM-DD');

  select level, xp, skill_points,
         coalesce((skills->>'finance')::integer, 0),
         coalesce((skills->>'leadership')::numeric, 0)
    into v_level, v_xp, v_skill_points, v_finance, v_leadership
    from player_profiles where user_id = p_user_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  perform 1 from wallets where user_id = p_user_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if exists(select 1 from daily_claims where user_id = p_user_id and date_key = v_date) then
    raise exception 'ALREADY_CLAIMED_TODAY';
  end if;

  v_amount := least(1500, greatest(450, round(450 + (v_level - 1) * 35 + v_finance * 25)::integer));
  v_next_xp := v_xp + 40;
  v_next_level := 1;
  while v_next_level < 100 loop
    if v_next_xp < (200 + (v_next_level - 1) * 120) then exit; end if;
    v_next_xp := v_next_xp - (200 + (v_next_level - 1) * 120);
    v_next_level := v_next_level + 1;
  end loop;

  insert into daily_claims(user_id, date_key, amount, claimed_at)
  values (p_user_id, v_date, v_amount, now());
  insert into transactions(id, from_uid, to_uid, amount, fee, net_amount, type, reference_id, description, status)
  values (v_tx_id, 'SYSTEM', p_user_id, v_amount, 0, v_amount, 'daily_stipend',
          v_claim_id, 'Daily operational stipend (' || to_char(v_date, 'YYYY-MM-DD') || ')', 'completed');
  update wallets set balance = balance + v_amount, total_earned = total_earned + v_amount,
      last_tx_id = v_tx_id, updated_at = now() where user_id = p_user_id;
  update player_profiles
     set xp = xp + 40, level = v_next_level,
         skill_points = skill_points + greatest(0, (v_next_level - v_level) * 2),
         reputation = reputation + round(2 * (1 + v_leadership * 0.1))::bigint,
         influence = influence + round(1 * (1 + v_leadership * 0.1))::bigint,
         updated_at = now()
   where user_id = p_user_id;
  insert into notifications(id, user_id, title, body, type, is_read)
  values (v_notification_id, p_user_id, 'Daily Stipend Credited',
          '+$' || v_amount::text || ' & +40 XP', 'economy', false);
  insert into audit_logs(id, user_id, action, entity_type, entity_id, details)
  values ('audit_' || v_tx_id, p_user_id, 'daily_stipend_claim', 'daily_claim', v_claim_id,
          jsonb_build_object('amount', v_amount, 'date_key', v_date));
  return jsonb_build_object('ok', true, 'amount', v_amount, 'dateKey', v_date, 'replayed', false);
end;
$$;
revoke all on function nexora.claim_daily_stipend(text) from public, anon, authenticated;
grant execute on function nexora.claim_daily_stipend(text) to service_role;
