# 🚀 Guía Rápida - Banco App (Frontend + Backend)

Tu aplicación bancaria está lista para usar. Aquí está el paso a paso para ejecutar todo.

## Paso 1: Levantar el Backend

```bash
cd /home/masita/Escritorio/PRACTICA2026/Banco/banco-backend

# En una terminal:
npm run dev
```

Deberías ver:
```
API bancaria escuchando en http://localhost:3000
```

## Paso 2: Levantar el Frontend

```bash
cd /home/masita/Escritorio/PRACTICA2026/Banco/banco-frontend

# En otra terminal:
npm run dev
```

Deberías ver:
```
> banco-frontend@1.0.0 dev
> next dev

 ▲ Next.js 14.2.3
 - Local:        http://localhost:3000
 - Environments: .env.local
```

## Paso 3: Acceder a la Aplicación

Abre tu navegador en: **http://localhost:3000**

### Home Page (/ )
- Página de bienvenida
- Botones "Iniciar Sesión" y "Crear Cuenta"
- Muestra estado de autenticación

### Login (/auth/sign-in)
- Componente de Clerk para iniciar sesión
- Redirige a /dashboard después de autenticarse

### Registro (/auth/sign-up)
- Componente de Clerk para crear nuevas cuentas
- Redirige a /dashboard después de registrarse

### Dashboard (/dashboard)
- Página protegida (requiere autenticación)
- Muestra datos del usuario
- Integración con backend API
- Botón de logout (UserButton)

---

## 🔑 Flujo de Autenticación Completo

```
1. Usuario accede a http://localhost:3000
                        ↓
2. Si no está logueado:
   → Elige "Iniciar Sesión" o "Crear Cuenta"
   → Completa formulario de Clerk
                        ↓
3. Clerk valida credenciales y genera token JWT
                        ↓
4. Frontend recibe el token y lo almacena
                        ↓
5. Frontend redirige a /dashboard
                        ↓
6. Dashboard obtiene datos del usuario
   → Envía token JWT al backend
   → Backend valida token con CLERK_SECRET_KEY
   → Backend retorna datos del usuario
                        ↓
7. User logged in ✅
```

---

## 📋 Variables de Entorno Configuradas

### Backend (.env)
```env
PORT=3000
DATABASE_URL=postgresql://...
CLERK_SECRET_KEY=sk_test_...
```

### Frontend (.env.local)
```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/auth/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/auth/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard
```

---

## 🧪 Probar los Endpoints desde Postman

### 1. Health Check
```
GET http://localhost:3000/api/health
→ { "ok": true, "service": "banco-backend" }
```

### 2. Crear Persona
```
POST http://localhost:3000/api/personas
Content-Type: application/json

{
  "nombre": "Juan",
  "apellido": "Pérez",
  "dni": "12345678",
  "email": "juan@test.com"
}
```

### 3. Registrar Usuario
```
POST http://localhost:3000/auth/register
Content-Type: application/json

{
  "persona_id": "<id-de-persona>",
  "clerk_id": "<clerk_id_del_usuario>"
}
```

### 4. Login (con token de Clerk)
```
POST http://localhost:3000/auth/login
Authorization: Bearer <token_clerk>
```

---

## 📁 Estructura del Proyecto

```
Banco/
├── banco-backend/          # API Express + PostgreSQL + Clerk
│   ├── src/
│   │   ├── app.js
│   │   ├── server.js
│   │   ├── config/env.js
│   │   ├── middlewares/
│   │   │   └── clerk-auth.js (✨ NUEVO)
│   │   ├── modules/
│   │   │   ├── auth-router.js (✨ NUEVO)
│   │   │   ├── auth-service.js (✨ NUEVO)
│   │   │   ├── crud-router.js
│   │   │   └── ...
│   │   ├── routes/
│   │   └── utils/
│   ├── .env (configurado)
│   └── package.json (con @clerk/express)
│
├── banco-frontend/         # Next.js 14 + Clerk + Tailwind (✨ NUEVO)
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx (home)
│   │   ├── globals.css
│   │   ├── auth/
│   │   │   ├── layout.tsx
│   │   │   ├── sign-in/page.tsx
│   │   │   └── sign-up/page.tsx
│   │   ├── dashboard/
│   │   │   └── page.tsx (protegida)
│   │   └── api/
│   │       └── profile/route.ts
│   ├── public/
│   ├── .env.local (configurado)
│   ├── next.config.js
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   └── package.json
│
└── Viejo/                  # Versión anterior (puedes ignorar)
```

---

## ⚠️ Problemas Comunes

### Error: "Token inválido o expirado"
- Asegúrate de que el token de Clerk sea válido
- Verifica que `CLERK_SECRET_KEY` sea correcto en `.env` del backend

### Error: "CORS policy"
- El backend tiene `cors()` habilitado
- Si aún hay problemas, verifica que ambos servicios usen los puertos correctos

### Error: "User not found"
- Primero crea una persona con `POST /api/personas`
- Luego registra el usuario con `POST /auth/register`

### Error: "Cannot find module"
- Ejecuta `npm install` en la carpeta correspondiente
- Si persiste, usa `npm install --legacy-peer-deps` en el frontend

---

## 📊 Próximos Pasos (Recomendados)

1. **Crear más tipos de usuarios:**
   - Admin, Cliente, Empleado
   - Usar tabla `personas_roles`

2. **Implementar auditoría:**
   - Cada acción se registra en tabla `auditoria`
   - Agregar middleware para loguear cambios

3. **Agregar más endpoints:**
   - Transferencias entre cuentas
   - Historial de transacciones
   - Gestión de tarjetas

4. **Mejorar frontend:**
   - Dashboard con gráficos
   - Gestión de cuentas y tarjetas
   - Transferencias interactivas

5. **Desplegar:**
   - Backend: Render, Heroku, AWS
   - Frontend: Vercel, Netlify, AWS

---

## 🔗 Links Útiles

- **Dashboard Clerk:** https://dashboard.clerk.com
- **Next.js Docs:** https://nextjs.org/docs
- **API Banco:** http://localhost:3000
- **Frontend Banco:** http://localhost:3000

---

**¿Todo funciona?** 🎉✅

Si tienes problemas, revisa:
1. ¿Backend está corriendo? (npm run dev)
2. ¿Frontend está corriendo? (npm run dev)
3. ¿Las variables .env están configuradas?
4. ¿El puerto 3000 está disponible?

¡Éxito! 🚀
