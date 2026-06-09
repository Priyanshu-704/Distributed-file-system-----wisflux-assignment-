CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE upload_status AS ENUM ('PENDING', 'UPLOADING', 'COMPLETED', 'FAILED');

CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(255) NOT NULL,
    total_chunks INTEGER NOT NULL,
    uploaded_chunks INTEGER[] DEFAULT '{}',
    status upload_status DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE processed_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    upload_session_id UUID UNIQUE NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    original_name VARCHAR(255) NOT NULL,
    processed_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    processing_duration INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL,
    error_message TEXT,
    minio_key TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for scalable query performance
CREATE INDEX idx_upload_sessions_created_at ON upload_sessions(created_at DESC);
CREATE INDEX idx_processed_files_status ON processed_files(status);
