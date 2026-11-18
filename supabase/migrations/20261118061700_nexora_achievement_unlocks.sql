create or replace function nexora.claim_eligible_achievements(p_user_id text)
returns jsonb language plpgsql security definer set search_path=nexora,pg_temp as $$
declare v_profile player_profiles%rowtype; v_stats jsonb; v_id text; v_unlocked text[]:=array[]::text[];
begin
 if p_user_id is null then raise exception 'UNAUTHENTICATED'; end if;
 select * into v_profile from player_profiles where user_id=p_user_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 v_stats:=coalesce(v_profile.stats,'{}'::jsonb);
 for v_id in
  select x.achievement_id from (values
   ('ach_merchant',coalesce((v_stats->>'tradesCount')::numeric,0)>=5),
   ('ach_industrial_pioneer',coalesce((v_stats->>'totalProduced')::numeric,0)>=5),
   ('ach_tycoon',coalesce((v_stats->>'companiesOwned')::numeric,0)>=2),
   ('ach_landlord',coalesce((v_stats->>'propertiesOwned')::numeric,0)>=2),
   ('ach_level_5',v_profile.level>=5),
   ('ach_reputation_100',v_profile.reputation>100)
  ) as x(achievement_id,is_eligible) where x.is_eligible
 loop
  insert into player_achievements(user_id,achievement_id,unlocked_at)
  values(p_user_id,v_id,now()) on conflict(user_id,achievement_id) do nothing;
  if found then v_unlocked:=array_append(v_unlocked,v_id); end if;
 end loop;
 return jsonb_build_object('ok',true,'unlockedIds',to_jsonb(v_unlocked));
end $$;
revoke all on function nexora.claim_eligible_achievements(text) from public,anon,authenticated;
grant execute on function nexora.claim_eligible_achievements(text) to service_role;
