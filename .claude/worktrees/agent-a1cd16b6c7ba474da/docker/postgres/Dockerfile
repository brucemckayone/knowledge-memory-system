# PostgreSQL 16 with pgvector and Apache AGE
# Based on pgvector image with AGE compiled from source

FROM pgvector/pgvector:pg16

# Install build dependencies for Apache AGE
# postgresql-server-dev-16 contains the header files needed to compile AGE
RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    libreadline-dev \
    zlib1g-dev \
    flex \
    bison \
    postgresql-server-dev-16 \
    && rm -rf /var/lib/apt/lists/*

# Clone and build Apache AGE
# Using a stable release tag
WORKDIR /tmp
RUN git clone --depth 1 --branch release/PG16/1.5.0 https://github.com/apache/age.git && \
    cd age && \
    make PG_CONFIG=/usr/bin/pg_config install && \
    cd .. && rm -rf age

# Cleanup build dependencies to reduce image size
RUN apt-get purge -y --auto-remove \
    build-essential \
    git \
    flex \
    bison \
    postgresql-server-dev-16

# Set up initialization script for AGE
COPY init-age.sql /docker-entrypoint-initdb.d/

WORKDIR /var/lib/postgresql/data
