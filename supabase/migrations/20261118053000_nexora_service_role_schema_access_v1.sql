grant usage on schema nexora to service_role;
grant all privileges on all tables in schema nexora to service_role;
grant usage, select on all sequences in schema nexora to service_role;
grant execute on all functions in schema nexora to service_role;

alter default privileges in schema nexora
  grant all privileges on tables to service_role;
alter default privileges in schema nexora
  grant usage, select on sequences to service_role;
alter default privileges in schema nexora
  grant execute on functions to service_role;
