/**
 * Pool de hilos de Node (libuv). Tiene que configurarse ANTES de cualquier
 * operación asíncrona de disco, DNS o cifrado, por eso main.ts lo importa
 * primero.
 *
 * El hash de contraseñas (bcrypt nativo), la lectura de archivos y las
 * búsquedas DNS comparten este pool. Con el tamaño por defecto (4), una
 * ráfaga de logins dejaba esperando hasta 2,4 s a peticiones que solo leen
 * el disco (auditoría 17-nov-2026). Con 16 hilos y el hash limitado a 4 a la
 * vez (HASH_CONCURRENCY), siempre quedan hilos libres para el resto.
 * Se respeta un UV_THREADPOOL_SIZE definido en el entorno.
 */
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

export {};
