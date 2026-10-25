/**
 * User management routes — CRUD for users within an org.
 * All routes require authentication via authMiddleware.
 * Role-based access: owner > admin > member.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from './auth-middleware.js';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/utils/logger.js';
import { validatePassword } from './password-policy.js';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/users — list all users in org
  app.get('/api/v1/users', async (request: FastifyRequest) => {
    const user = request.user!;
    const users = await prisma.user.findMany({
      where: { orgId: user.orgId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        teamId: true,
        createdAt: true,
        team: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { users };
  });

  // POST /api/v1/users — create user (owner/admin only)
  app.post('/api/v1/users', async (request: FastifyRequest, reply: FastifyReply) => {
    const currentUser = request.user!;
    if (!['owner', 'admin'].includes(currentUser.role)) {
      return reply.status(403).send({ error: 'Không có quyền' });
    }

    const { email, fullName, password, role = 'member', teamId } = request.body as any;
    if (!email || !fullName || !password) {
      return reply.status(400).send({ error: 'Email, họ tên, mật khẩu là bắt buộc' });
    }
    const pwError = validatePassword(password);
    if (pwError) return reply.status(400).send({ error: pwError });
    if (!['member', 'admin'].includes(role)) {
      return reply.status(400).send({ error: 'Role không hợp lệ' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.status(400).send({ error: 'Email đã tồn tại' });

    if (role === 'owner') return reply.status(400).send({ error: 'Không thể tạo thêm owner' });
    if (role === 'admin' && currentUser.role !== 'owner') {
      return reply.status(403).send({ error: 'Chỉ owner có thể tạo admin' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        orgId: currentUser.orgId,
        email,
        fullName,
        passwordHash,
        role,
        teamId: teamId || null,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    logger.info(`User created: ${user.email} by ${currentUser.email}`);
    return user;
  });

  // PUT /api/v1/users/:id — update user info
  app.put('/api/v1/users/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const currentUser = request.user!;
    const { id } = request.params as { id: string };

    if (!['owner', 'admin'].includes(currentUser.role) && currentUser.id !== id) {
      return reply.status(403).send({ error: 'Không có quyền' });
    }

    const { fullName, email, role, teamId, isActive } = request.body as any;

    if (id === currentUser.id && role && role !== currentUser.role) {
      return reply.status(400).send({ error: 'Không thể thay đổi role của chính mình' });
    }

    // Only the owner may touch the owner account or promote anyone to owner
    const target = await prisma.user.findFirst({ where: { id, orgId: currentUser.orgId }, select: { role: true } });
    if (!target) return reply.status(404).send({ error: 'User not found' });
    if (target.role === 'owner' && currentUser.role !== 'owner') {
      return reply.status(403).send({ error: 'Không thể sửa tài khoản owner' });
    }
    if (role !== undefined && !['member', 'admin', 'owner'].includes(role)) {
      return reply.status(400).send({ error: 'Role không hợp lệ' });
    }
    if (role === 'owner' && target.role !== 'owner') {
      return reply.status(400).send({ error: 'Không thể tạo thêm owner' });
    }
    // Members may only change their own name
    if (currentUser.role === 'member' && (email !== undefined || teamId !== undefined)) {
      return reply.status(403).send({ error: 'Không có quyền' });
    }

    const updateData: any = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (email !== undefined) updateData.email = email;
    if (role !== undefined && currentUser.role === 'owner') updateData.role = role;
    if (teamId !== undefined) updateData.teamId = teamId || null;
    if (isActive !== undefined && currentUser.role === 'owner') updateData.isActive = isActive;

    const user = await prisma.user.update({
      where: { id, orgId: currentUser.orgId },
      data: updateData,
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        teamId: true,
      },
    });

    return user;
  });

  // PUT /api/v1/users/:id/password — reset password (owner/admin only)
  app.put('/api/v1/users/:id/password', async (request: FastifyRequest, reply: FastifyReply) => {
    const currentUser = request.user!;
    if (!['owner', 'admin'].includes(currentUser.role)) {
      return reply.status(403).send({ error: 'Không có quyền' });
    }

    const { id } = request.params as { id: string };
    const { password } = request.body as { password: string };
    const pwError = validatePassword(password);
    if (pwError) return reply.status(400).send({ error: pwError });

    // Admins cannot reset the owner's password
    const target = await prisma.user.findFirst({ where: { id, orgId: currentUser.orgId }, select: { role: true } });
    if (!target) return reply.status(404).send({ error: 'User not found' });
    if (target.role === 'owner' && currentUser.role !== 'owner') {
      return reply.status(403).send({ error: 'Không thể đặt lại mật khẩu owner' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id, orgId: currentUser.orgId },
      data: { passwordHash },
    });

    return { success: true };
  });

  // DELETE /api/v1/users/:id — deactivate user (owner only)
  app.delete('/api/v1/users/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const currentUser = request.user!;
    if (currentUser.role !== 'owner') {
      return reply.status(403).send({ error: 'Chỉ owner có quyền xóa nhân viên' });
    }

    const { id } = request.params as { id: string };
    if (id === currentUser.id) {
      return reply.status(400).send({ error: 'Không thể xóa chính mình' });
    }

    await prisma.user.update({
      where: { id, orgId: currentUser.orgId },
      data: { isActive: false },
    });

    return { success: true };
  });
}
