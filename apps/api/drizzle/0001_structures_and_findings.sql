ALTER TABLE "job_objects" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_objects" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "non_conforming" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "is_serial_plate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_objects" ADD CONSTRAINT "job_objects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "photos_one_serial_plate" ON "photos" USING btree ("job_id","object_id") WHERE is_serial_plate AND status = 'ready';--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_non_conforming_in_report" CHECK (NOT non_conforming OR include_in_report);