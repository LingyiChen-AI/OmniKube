docker  pull --platform linux/amd64 twwch/omnikube:frontend-latest

docker  pull --platform linux/amd64 twwch/omnikube:api-latest  

docker-compose -f docker-compose-local.yml up -d                