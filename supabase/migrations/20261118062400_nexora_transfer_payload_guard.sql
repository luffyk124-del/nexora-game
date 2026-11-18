-- NEXORA wallet transfer: atomic, authenticated through the Edge Function, idempotent.
-- This migration is scoped exclusively to the nexora schema.
create or replace function nexora.transfer_credits(
  p_sender_uid text,
  p_recipient_username text,
  p_amount bigint,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = nexora, pg_temp
as $$
declare
  v_recipient_uid text;
  v_recipient_name text;
  v_sender_balance numeric;
  v_recipient_balance numeric;
  v_sender_earned numeric;
  v_sender_spent numeric;
  v_recipient_earned numeric;
  v_recipient_spent numeric;
  v_tx_id text;
  v_note text;
  v_existing transactions%rowtype;
begin
  if p_sender_uid is null or length(p_sender_uid) < 1 then
    raise exception 'UNAUTHENTICATED';
  end if;
  if p_request_id is null then
    raise exception 'INVALID_REQUEST_ID';
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 10000000 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_recipient_username is null or length(trim(p_recipient_username)) not between 3 and 24
     or trim(p_recipient_username) !~ '^[A-Za-z0-9_]{3,24}$' then
    raise exception 'RECIPIENT_NOT_FOUND';
  end if;

  select uid, username into v_recipient_uid, v_recipient_name
  from usernames
  where username_lower = lower(trim(p_recipient_username));

  if v_recipient_uid is null then
    raise exception 'RECIPIENT_NOT_FOUND';
  end if;
  if v_recipient_uid = p_sender_uid then
    raise exception 'SELF_OR_MISSING_RECIPIENT';
  end if;

  v_tx_id := 'transfer_' || p_sender_uid || '_' || p_request_id::text;

  select * into v_existing from transactions where id = v_tx_id;
  if found then
    if v_existing.from_uid <> p_sender_uid or v_existing.to_uid <> v_recipient_uid
       or v_existing.amount <> p_amount or v_existing.type <> 'transfer' then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object('ok', true, 'transactionId', v_tx_id, 'replayed', true);
  end if;

  -- Lock both wallets in a deterministic order to prevent deadlocks.
  if p_sender_uid < v_recipient_uid then
    select balance, total_earned, total_spent
      into v_sender_balance, v_sender_earned, v_sender_spent
      from wallets where user_id = p_sender_uid for update;
    select balance, total_earned, total_spent
      into v_recipient_balance, v_recipient_earned, v_recipient_spent
      from wallets where user_id = v_recipient_uid for update;
  else
    select balance, total_earned, total_spent
      into v_recipient_balance, v_recipient_earned, v_recipient_spent
      from wallets where user_id = v_recipient_uid for update;
    select balance, total_earned, total_spent
      into v_sender_balance, v_sender_earned, v_sender_spent
      from wallets where user_id = p_sender_uid for update;
  end if;

  if v_sender_balance is null or v_recipient_balance is null then
    raise exception 'RECIPIENT_NOT_FOUND';
  end if;

  -- Recheck after acquiring wallet locks: concurrent retries with the same request ID
  -- must observe the first committed transfer rather than debit the sender twice.
  select * into v_existing from transactions where id = v_tx_id;
  if found then
    if v_existing.from_uid <> p_sender_uid or v_existing.to_uid <> v_recipient_uid
       or v_existing.amount <> p_amount or v_existing.type <> 'transfer' then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object('ok', true, 'transactionId', v_tx_id, 'replayed', true);
  end if;

  if v_sender_balance < p_amount then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  v_note := coalesce(nullif(left(trim(coalesce(p_note, '')), 180), ''), 'Transfer to ' || v_recipient_name);

  update wallets
    set balance = balance - p_amount,
        total_spent = total_spent + p_amount,
        last_tx_id = v_tx_id,
        updated_at = now()
    where user_id = p_sender_uid;

  update wallets
    set balance = balance + p_amount,
        total_earned = total_earned + p_amount,
        last_tx_id = v_tx_id,
        updated_at = now()
    where user_id = v_recipient_uid;

  insert into transactions(id, from_uid, to_uid, amount, fee, net_amount, type, reference_id, description, status)
  values (v_tx_id, p_sender_uid, v_recipient_uid, p_amount, 0, p_amount, 'transfer', v_recipient_uid, v_note, 'completed');

  insert into audit_logs(id, user_id, action, entity_type, entity_id, details)
  values ('audit_' || v_tx_id, p_sender_uid, 'wallet_transfer', 'transaction', v_tx_id,
          jsonb_build_object('recipient_uid', v_recipient_uid, 'amount', p_amount));

  insert into notifications(id, user_id, title, body, type, is_read)
  values ('notification_' || v_tx_id, p_sender_uid, 'Transfer Sent',
          '-$' || to_char(p_amount, 'FM999,999,999,990') || ' -> ' || v_recipient_name,
          'economy', false);

  return jsonb_build_object('ok', true, 'transactionId', v_tx_id, 'replayed', false);
end;
$$;

revoke all on function nexora.transfer_credits(text,text,bigint,text,uuid) from public, anon, authenticated;
grant execute on function nexora.transfer_credits(text,text,bigint,text,uuid) to service_role;
