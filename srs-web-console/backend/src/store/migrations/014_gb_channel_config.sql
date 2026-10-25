-- Desired channel settings and binding are saved in one parameter transaction.
ALTER TABLE gb28181_bindings ADD COLUMN channel_config JSONB;
ALTER TABLE gb28181_bindings ADD COLUMN applied_config JSONB;
