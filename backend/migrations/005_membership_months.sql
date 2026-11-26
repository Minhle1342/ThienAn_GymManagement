ALTER TABLE transactions ADD COLUMN membership_months INTEGER
 CHECK(membership_months IS NULL OR
       (category = 'membership' AND typeof(membership_months) = 'integer' AND membership_months > 0));
