-- What an order line needs to be read back as the customer saw it: the unit as said ("libra"), and
-- whether it is alcohol or tobacco (never priced or confirmed in chat). NULL unit = none was said.
ALTER TABLE order_lines ADD COLUMN unit TEXT;
ALTER TABLE order_lines ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1));
